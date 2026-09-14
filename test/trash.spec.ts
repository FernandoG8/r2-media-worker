import { beforeEach, describe, expect, it, vi } from 'vitest';

const { s3List, getClient, getClientCredentials } = vi.hoisted(() => ({
  s3List: vi.fn(), getClient: vi.fn(), getClientCredentials: vi.fn(),
}));

vi.mock('../src/access', () => ({
  verifyAccessJwt: vi.fn(async () => ({ ok: true })),
}));
vi.mock('../src/clients', () => ({
  getClient,
  getClientCredentials,
  listClients: vi.fn(), createClient: vi.fn(), deleteClient: vi.fn(), updateClientConfig: vi.fn(),
}));
vi.mock('../src/s3', () => ({
  createS3Client: vi.fn(() => ({ s3List, s3Get: vi.fn(), s3Head: vi.fn(), s3Copy: vi.fn(), s3Delete: vi.fn(), s3Put: vi.fn(), s3Presign: vi.fn(), s3PutBucketCors: vi.fn(), s3UpdateMetadata: vi.fn() })),
}));

import { handleRequest } from '../src/router';
import { verifyAccessJwt } from '../src/access';
import type { Env } from '../src/types';

const env = { API_SECRET: 'secret', ALLOWED_ORIGIN: 'https://panel-v2.mizcor.dev', CLIENTS_KV: {}, MASTER_KEY: 'master', TEAM_DOMAIN: 'https://access.example', POLICY_AUD: 'aud' } as unknown as Env;
const uuid = '123e4567-e89b-42d3-a456-426614174000';
const headers = { 'X-API-Key': 'secret', 'X-Client-ID': 'client' };

beforeEach(() => {
  vi.clearAllMocks();
  getClient.mockResolvedValue({ bucketName: 'bucket', endpoint: 'https://s3.example' });
  getClientCredentials.mockResolvedValue({ accessKeyId: 'key', secretAccessKey: 'secret' });
  s3List.mockResolvedValue({ folders: [], objects: [], nextContinuationToken: null, isTruncated: false });
});

describe('trash read contract', () => {
  it('lists UUID groups with delimiter and an opaque cursor', async () => {
    s3List.mockResolvedValueOnce({ folders: [`.mediapanel-trash/${uuid}/`, '.mediapanel-trash/not-a-uuid/', '.mediapanel-trash/other/x/'], objects: [], nextContinuationToken: 'opaque+/=', isTruncated: true });
    const response = await handleRequest(new Request('https://worker.example/api/trash?limit=7&cursor=opaque%2B%2F%3D', { headers }), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ groups: [{ restoreToken: uuid, count: null }], nextCursor: 'opaque+/=' });
    expect(s3List).toHaveBeenCalledWith('bucket', '.mediapanel-trash/', '/', 7, 'opaque+/=');
  });

  it('lists detail items without the internal prefix', async () => {
    s3List.mockResolvedValueOnce({ folders: [], objects: [{ key: `.mediapanel-trash/${uuid}/gallery/a.jpg`, size: 12, lastModified: '2026-09-12T00:00:00Z' }], nextContinuationToken: null, isTruncated: false });
    const response = await handleRequest(new Request(`https://worker.example/api/trash/${uuid}`, { headers }), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ items: [{ key: 'gallery/a.jpg', size: 12, uploaded: '2026-09-12T00:00:00Z' }], nextCursor: null });
    expect(s3List).toHaveBeenCalledWith('bucket', `.mediapanel-trash/${uuid}/`, '', 100, undefined);
  });

  it('rejects invalid UUID and limits before storage access', async () => {
    const response = await handleRequest(new Request('https://worker.example/api/trash/nope?limit=100', { headers }), env);
    expect(response.status).toBe(400);
    expect(s3List).not.toHaveBeenCalled();
  });

  it.each(['', '0', '1.5', '-1', '101'])('rejects invalid group limit %j', async (limit) => {
    const response = await handleRequest(new Request(`https://worker.example/api/trash?limit=${encodeURIComponent(limit)}`, { headers }), env);
    expect(response.status).toBe(400);
    expect(s3List).not.toHaveBeenCalled();
  });

  it('accepts encoded opaque cursor symbols and forwards detail pagination', async () => {
    const cursor = '+/=:';
    s3List.mockResolvedValueOnce({ folders: [], objects: [{ key: `.mediapanel-trash/${uuid}/a`, size: 1, lastModified: '' }], nextContinuationToken: 'next', isTruncated: true });
    const response = await handleRequest(new Request(`https://worker.example/api/trash/${uuid}?limit=1000&cursor=${encodeURIComponent(cursor)}`, { headers }), env);
    expect(response.status).toBe(200);
    expect(s3List).toHaveBeenCalledWith('bucket', `.mediapanel-trash/${uuid}/`, '', 1000, cursor);
  });

  it('accepts a 4096-character cursor and rejects 4097 before storage on both routes', async () => {
    const accepted = 'x'.repeat(4096);
    s3List.mockResolvedValueOnce({ folders: [], objects: [], nextContinuationToken: null, isTruncated: false });
    const groups = await handleRequest(new Request(`https://worker.example/api/trash?cursor=${accepted}`, { headers }), env);
    expect(groups.status).toBe(200);
    expect(s3List).toHaveBeenCalledWith('bucket', '.mediapanel-trash/', '/', 20, accepted);

    s3List.mockResolvedValueOnce({ folders: [], objects: [{ key: `.mediapanel-trash/${uuid}/a`, size: 1, lastModified: '' }], nextContinuationToken: null, isTruncated: false });
    const detail = await handleRequest(new Request(`https://worker.example/api/trash/${uuid}?cursor=${accepted}`, { headers }), env);
    expect(detail.status).toBe(200);
    expect(s3List).toHaveBeenCalledWith('bucket', `.mediapanel-trash/${uuid}/`, '', 100, accepted);

    const tooLong = 'x'.repeat(4097);
    const before = s3List.mock.calls.length;
    expect((await handleRequest(new Request(`https://worker.example/api/trash?cursor=${tooLong}`, { headers }), env)).status).toBe(400);
    expect((await handleRequest(new Request(`https://worker.example/api/trash/${uuid}?cursor=${tooLong}`, { headers }), env)).status).toBe(400);
    expect(s3List.mock.calls.length).toBe(before);
  });

  it('sanitizes provider errors on both group and detail listing', async () => {
    s3List.mockRejectedValueOnce(new Error('S3 ListObjectsV2 failed: 400 <secret xml>'));
    const groups = await handleRequest(new Request('https://worker.example/api/trash', { headers }), env);
    expect(groups.status).toBe(502);
    expect(await groups.json()).toEqual({ error: 'Could not list trash' });

    s3List.mockRejectedValueOnce(new Error('S3 ListObjectsV2 failed: 400 <secret xml>'));
    const detail = await handleRequest(new Request(`https://worker.example/api/trash/${uuid}`, { headers }), env);
    expect(detail.status).toBe(502);
    expect(await detail.json()).toEqual({ error: 'Could not list trash group' });
  });

  it('preserves Access, API key, missing client, and unknown client boundaries', async () => {
    vi.mocked(verifyAccessJwt).mockResolvedValueOnce({ ok: false, status: 403, error: 'Access denied' });
    expect((await handleRequest(new Request('https://worker.example/api/trash'), env)).status).toBe(403);

    expect((await handleRequest(new Request('https://worker.example/api/trash', { headers: { 'X-Client-ID': 'client' } }), env)).status).toBe(401);
    expect((await handleRequest(new Request('https://worker.example/api/trash', { headers: { 'X-API-Key': 'secret' } }), env)).status).toBe(400);
    getClient.mockResolvedValueOnce(null);
    expect((await handleRequest(new Request('https://worker.example/api/trash', { headers }), env)).status).toBe(404);
  });

  it('queries only the authenticated client bucket and filters foreign detail keys', async () => {
    getClient.mockResolvedValueOnce({ bucketName: 'bucket-b', endpoint: 'https://s3.example' });
    s3List.mockResolvedValueOnce({ folders: [], objects: [
      { key: `.mediapanel-trash/${uuid}/ok.jpg`, size: 3, lastModified: 'date' },
      { key: `.mediapanel-trash/${uuid}9/foreign.jpg`, size: 9, lastModified: 'date' },
      { key: '.mediapanel-trash/other/hidden.jpg', size: 9, lastModified: 'date' },
    ], nextContinuationToken: null, isTruncated: false });
    const response = await handleRequest(new Request(`https://worker.example/api/trash/${uuid}`, { headers }), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ items: [{ key: 'ok.jpg' }] });
    expect(s3List).toHaveBeenCalledWith('bucket-b', `.mediapanel-trash/${uuid}/`, '', 100, undefined);
  });

  it('does not reveal a token from another client bucket', async () => {
    getClient.mockImplementationOnce(async (_kv: unknown, clientId: string) => clientId === 'client-b' ? { bucketName: 'bucket-b', endpoint: 'https://s3.example' } : { bucketName: 'bucket-a', endpoint: 'https://s3.example' });
    s3List.mockResolvedValueOnce({ folders: [], objects: [], nextContinuationToken: null, isTruncated: false });
    const response = await handleRequest(new Request(`https://worker.example/api/trash/${uuid}`, { headers: { ...headers, 'X-Client-ID': 'client-b' } }), env);
    expect(response.status).toBe(404);
    expect(s3List).toHaveBeenCalledTimes(1);
    expect(s3List).toHaveBeenCalledWith('bucket-b', `.mediapanel-trash/${uuid}/`, '', 100, undefined);
    expect(s3List).not.toHaveBeenCalledWith('bucket-a', expect.anything(), expect.anything(), expect.anything(), expect.anything());
  });

  it('returns controlled errors for missing groups and malformed storage pages', async () => {
    s3List.mockResolvedValueOnce({ folders: [], objects: [], nextContinuationToken: null, isTruncated: false });
    const missing = await handleRequest(new Request(`https://worker.example/api/trash/${uuid}`, { headers }), env);
    expect(missing.status).toBe(404);
    s3List.mockResolvedValueOnce({ folders: [], objects: [], nextContinuationToken: null, isTruncated: true });
    const truncated = await handleRequest(new Request('https://worker.example/api/trash', { headers }), env);
    expect(truncated.status).toBe(502);
    s3List.mockResolvedValueOnce({ folders: [], objects: [{ key: `.mediapanel-trash/${uuid}/a`, size: 1, lastModified: '' }], nextContinuationToken: null, isTruncated: true });
    const truncatedDetail = await handleRequest(new Request(`https://worker.example/api/trash/${uuid}`, { headers }), env);
    expect(truncatedDetail.status).toBe(502);
  });
});
