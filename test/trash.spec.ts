import { beforeEach, describe, expect, it, vi } from 'vitest';

const { s3List, s3Get, s3Head, s3Copy, s3Delete, getClient, getClientCredentials } = vi.hoisted(() => ({
  s3List: vi.fn(), s3Get: vi.fn(), s3Head: vi.fn(), s3Copy: vi.fn(), s3Delete: vi.fn(),
  getClient: vi.fn(), getClientCredentials: vi.fn(),
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
  TRASH_PREFIX: '.mediapanel-trash/',
  createS3Client: vi.fn(() => ({
    s3List,
    s3Get,
    s3Head,
    s3Copy,
    s3Delete,
    s3Put: vi.fn(),
    s3Presign: vi.fn(),
    s3PutBucketCors: vi.fn(),
    s3UpdateMetadata: vi.fn(),
    s3GetBucketLifecycleConfiguration: vi.fn(),
    s3PutBucketLifecycleConfiguration: vi.fn(),
    s3ApplyTrashLifecycleRule: vi.fn(),
  })),
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
  s3Get.mockResolvedValue(new Response(null, { status: 404 }));
  s3Head.mockResolvedValue(new Response(null, { status: 404 }));
  s3Copy.mockResolvedValue(undefined);
  s3Delete.mockResolvedValue(undefined);
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

describe('deleted objects never become publicly reachable', () => {
  it('/file/:clientId/:key still returns 404 for a key inside .mediapanel-trash/, never serving deleted content', async () => {
    const response = await handleRequest(
      new Request(`https://worker.example/file/client/.mediapanel-trash/${uuid}/gallery/a.jpg`),
      env,
    );
    expect(response.status).toBe(404);
    expect(getClient).not.toHaveBeenCalled();
    expect(s3Get).not.toHaveBeenCalled();
  });
});

describe('GET /api/trash/:restoreToken/object — authenticated thumbnail read', () => {
  const objectUrl = (token: string, key: string) =>
    `https://worker.example/api/trash/${token}/object?key=${encodeURIComponent(key)}`;

  it('requires X-API-Key (401 without it)', async () => {
    const response = await handleRequest(
      new Request(objectUrl(uuid, 'gallery/a.jpg'), { headers: { 'X-Client-ID': 'client' } }),
      env,
    );
    expect(response.status).toBe(401);
    expect(s3Get).not.toHaveBeenCalled();
  });

  it('requires X-Client-ID (400 without it)', async () => {
    const response = await handleRequest(
      new Request(objectUrl(uuid, 'gallery/a.jpg'), { headers: { 'X-API-Key': 'secret' } }),
      env,
    );
    expect(response.status).toBe(400);
    expect(s3Get).not.toHaveBeenCalled();
  });

  it('serves the object bytes with its real Content-Type and a private, non-shareable cache policy', async () => {
    s3Get.mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'image/jpeg' } }));
    const response = await handleRequest(new Request(objectUrl(uuid, 'gallery/a.jpg'), { headers }), env);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/jpeg');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(s3Get).toHaveBeenCalledWith('bucket', `.mediapanel-trash/${uuid}/gallery/a.jpg`);
  });

  it('rejects a malformed restore token before touching storage', async () => {
    const response = await handleRequest(new Request(objectUrl('not-a-uuid', 'gallery/a.jpg'), { headers }), env);
    expect(response.status).toBe(400);
    expect(s3Get).not.toHaveBeenCalled();
  });

  it('404s when the requested key does not exist under that client bucket (also covers a foreign client bucket)', async () => {
    getClient.mockResolvedValueOnce({ bucketName: 'bucket-b', endpoint: 'https://s3.example' });
    const response = await handleRequest(
      new Request(objectUrl(uuid, 'gallery/a.jpg'), { headers: { ...headers, 'X-Client-ID': 'client-b' } }),
      env,
    );
    expect(response.status).toBe(404);
    expect(s3Get).toHaveBeenCalledWith('bucket-b', `.mediapanel-trash/${uuid}/gallery/a.jpg`);
  });

  it('blocks a relative traversal key from escaping the trash group, without ever calling storage', async () => {
    const response = await handleRequest(new Request(objectUrl(uuid, '../secrets.jpg'), { headers }), env);
    expect(response.status).toBe(404);
    expect(s3Get).not.toHaveBeenCalled();
  });

  it('blocks an absolute-path key from escaping the trash group', async () => {
    const response = await handleRequest(new Request(objectUrl(uuid, '/etc/passwd'), { headers }), env);
    expect(response.status).toBe(404);
    expect(s3Get).not.toHaveBeenCalled();
  });

  it('blocks a nested traversal segment buried inside an otherwise plausible key', async () => {
    const response = await handleRequest(new Request(objectUrl(uuid, 'gallery/../../other-client/secret.jpg'), { headers }), env);
    expect(response.status).toBe(404);
    expect(s3Get).not.toHaveBeenCalled();
  });
});

describe('POST /api/restore — partial restore by keys', () => {
  const bodyHeaders = { ...headers, 'Content-Type': 'application/json' };
  const restore = (body: unknown) =>
    handleRequest(new Request('https://worker.example/api/restore', { method: 'POST', headers: bodyHeaders, body: JSON.stringify(body) }), env);

  it('restores only the requested subset, leaving the rest of the group intact', async () => {
    s3List.mockResolvedValueOnce({
      folders: [],
      objects: [
        { key: `.mediapanel-trash/${uuid}/gallery/a.jpg`, size: 1, lastModified: '' },
        { key: `.mediapanel-trash/${uuid}/gallery/b.jpg`, size: 1, lastModified: '' },
        { key: `.mediapanel-trash/${uuid}/gallery/c.jpg`, size: 1, lastModified: '' },
      ],
      nextContinuationToken: null,
      isTruncated: false,
    });
    const response = await restore({ restoreToken: uuid, keys: ['gallery/a.jpg'] });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, restored: ['gallery/a.jpg'] });
    expect(s3Copy).toHaveBeenCalledTimes(1);
    expect(s3Copy).toHaveBeenCalledWith('bucket', `.mediapanel-trash/${uuid}/gallery/a.jpg`, 'gallery/a.jpg');
    expect(s3Delete).toHaveBeenCalledTimes(1);
    expect(s3Delete).toHaveBeenCalledWith('bucket', `.mediapanel-trash/${uuid}/gallery/a.jpg`);
  });

  it('rejects the entire request when a requested key does not belong to the group — nothing is restored', async () => {
    s3List.mockResolvedValueOnce({
      folders: [],
      objects: [{ key: `.mediapanel-trash/${uuid}/gallery/a.jpg`, size: 1, lastModified: '' }],
      nextContinuationToken: null,
      isTruncated: false,
    });
    const response = await restore({ restoreToken: uuid, keys: ['gallery/a.jpg', 'gallery/not-in-group.jpg'] });
    expect(response.status).toBe(400);
    expect(s3Copy).not.toHaveBeenCalled();
    expect(s3Delete).not.toHaveBeenCalled();
  });

  it('restoring the last remaining key empties the group, which then drops out of GET /api/trash', async () => {
    s3List.mockResolvedValueOnce({
      folders: [],
      objects: [{ key: `.mediapanel-trash/${uuid}/gallery/a.jpg`, size: 1, lastModified: '' }],
      nextContinuationToken: null,
      isTruncated: false,
    });
    const response = await restore({ restoreToken: uuid, keys: ['gallery/a.jpg'] });
    expect(response.status).toBe(200);

    // Once the group's only object is moved out, storage stops returning its
    // prefix as a folder — the listing reflects that with no group at all.
    s3List.mockResolvedValueOnce({ folders: [], objects: [], nextContinuationToken: null, isTruncated: false });
    const listing = await handleRequest(new Request('https://worker.example/api/trash', { headers }), env);
    expect(await listing.json()).toEqual({ groups: [], nextCursor: null });
  });

  it('keeps restoring the whole group when keys is omitted — existing bulk-undo behavior is unchanged', async () => {
    s3List.mockResolvedValueOnce({
      folders: [],
      objects: [
        { key: `.mediapanel-trash/${uuid}/gallery/a.jpg`, size: 1, lastModified: '' },
        { key: `.mediapanel-trash/${uuid}/gallery/b.jpg`, size: 1, lastModified: '' },
      ],
      nextContinuationToken: null,
      isTruncated: false,
    });
    const response = await restore({ restoreToken: uuid });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, restored: ['gallery/a.jpg', 'gallery/b.jpg'] });
    expect(s3Copy).toHaveBeenCalledTimes(2);
    expect(s3Delete).toHaveBeenCalledTimes(2);
  });

  it('still enforces overwrite protection (409) and invalid-token/empty-group checks unchanged', async () => {
    s3List.mockResolvedValueOnce({
      folders: [],
      objects: [{ key: `.mediapanel-trash/${uuid}/gallery/a.jpg`, size: 1, lastModified: '' }],
      nextContinuationToken: null,
      isTruncated: false,
    });
    s3Head.mockResolvedValueOnce(new Response(null, { status: 200 }));
    const conflict = await restore({ restoreToken: uuid });
    expect(conflict.status).toBe(409);

    s3List.mockResolvedValueOnce({ folders: [], objects: [], nextContinuationToken: null, isTruncated: false });
    const emptyGroup = await restore({ restoreToken: uuid });
    expect(emptyGroup.status).toBe(404);

    const badToken = await restore({ restoreToken: 'not-a-uuid' });
    expect(badToken.status).toBe(400);
  });
});
