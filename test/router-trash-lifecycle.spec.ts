import { beforeEach, describe, expect, it, vi } from 'vitest';

const { s3PutBucketCors, s3ApplyTrashLifecycleRule, createClient, getClient, getClientCredentials } = vi.hoisted(() => ({
  s3PutBucketCors: vi.fn(),
  s3ApplyTrashLifecycleRule: vi.fn(),
  createClient: vi.fn(),
  getClient: vi.fn(),
  getClientCredentials: vi.fn(),
}));

vi.mock('../src/access', () => ({
  verifyAccessJwt: vi.fn(async () => ({ ok: true })),
}));
vi.mock('../src/clients', () => ({
  getClient,
  getClientCredentials,
  createClient,
  listClients: vi.fn(),
  deleteClient: vi.fn(),
  updateClientConfig: vi.fn(),
}));
vi.mock('../src/s3', () => ({
  TRASH_PREFIX: '.mediapanel-trash/',
  createS3Client: vi.fn(() => ({
    s3PutBucketCors,
    s3ApplyTrashLifecycleRule,
    s3List: vi.fn(),
    s3Get: vi.fn(),
    s3Put: vi.fn(),
    s3Delete: vi.fn(),
    s3Copy: vi.fn(),
    s3Head: vi.fn(),
    s3Presign: vi.fn(),
    s3UpdateMetadata: vi.fn(),
    s3GetBucketLifecycleConfiguration: vi.fn(),
    s3PutBucketLifecycleConfiguration: vi.fn(),
  })),
}));

import { handleRequest } from '../src/router';
import type { Env } from '../src/types';

const env = {
  API_SECRET: 'secret',
  ALLOWED_ORIGIN: 'https://panel-v2.mizcor.dev',
  TEAM_DOMAIN: 'https://example.cloudflareaccess.com',
  POLICY_AUD: 'test-audience',
  CLIENTS_KV: {},
  MASTER_KEY: 'master',
} as unknown as Env;

const newClientBody = {
  id: 'newclient',
  name: 'New Client',
  bucketName: 'newclient-bucket',
  endpoint: 'https://account.r2.cloudflarestorage.com',
  r2BaseUrl: '',
  accessKeyId: 'key',
  secretAccessKey: 'secret',
};

beforeEach(() => {
  vi.clearAllMocks();
  getClient.mockResolvedValue(null);
  createClient.mockResolvedValue(undefined);
  s3PutBucketCors.mockResolvedValue(undefined);
  s3ApplyTrashLifecycleRule.mockResolvedValue(undefined);
});

describe('POST /api/clients — trash lifecycle rule on creation', () => {
  it('applies the trash lifecycle rule alongside CORS when creating a client', async () => {
    const response = await handleRequest(new Request('https://worker.example/api/clients', {
      method: 'POST',
      headers: { 'X-API-Key': 'secret', 'Content-Type': 'application/json' },
      body: JSON.stringify(newClientBody),
    }), env);

    expect(response.status).toBe(201);
    expect(s3ApplyTrashLifecycleRule).toHaveBeenCalledWith('newclient-bucket');
    expect(await response.json()).toEqual({ id: 'newclient', name: 'New Client' });
  });

  it('still creates the client and reports the problem when the lifecycle rule fails to apply', async () => {
    s3ApplyTrashLifecycleRule.mockRejectedValue(new Error('R2 rejected the lifecycle policy'));

    const response = await handleRequest(new Request('https://worker.example/api/clients', {
      method: 'POST',
      headers: { 'X-API-Key': 'secret', 'Content-Type': 'application/json' },
      body: JSON.stringify(newClientBody),
    }), env);

    expect(response.status).toBe(201);
    expect(createClient).toHaveBeenCalledTimes(1);
    const payload = await response.json();
    expect(payload).toMatchObject({ id: 'newclient', name: 'New Client', lifecycleWarning: 'R2 rejected the lifecycle policy' });
  });

  it('still creates the client when CORS fails but the lifecycle rule succeeds', async () => {
    s3PutBucketCors.mockRejectedValue(new Error('CORS blew up'));

    const response = await handleRequest(new Request('https://worker.example/api/clients', {
      method: 'POST',
      headers: { 'X-API-Key': 'secret', 'Content-Type': 'application/json' },
      body: JSON.stringify(newClientBody),
    }), env);

    expect(response.status).toBe(201);
    expect(s3ApplyTrashLifecycleRule).toHaveBeenCalledWith('newclient-bucket');
    const payload = await response.json();
    expect(payload).toMatchObject({ id: 'newclient', corsWarning: 'CORS blew up' });
    expect(payload).not.toHaveProperty('lifecycleWarning');
  });
});

describe('POST /api/clients/:id/trash-lifecycle — reapply to an existing client', () => {
  const existingClient = { bucketName: 'existing-bucket', endpoint: 'https://s3.example', env: 'prod' };

  it('reapplies the rule to an existing client bucket', async () => {
    getClient.mockResolvedValue(existingClient);
    getClientCredentials.mockResolvedValue({ accessKeyId: 'key', secretAccessKey: 'secret' });

    const response = await handleRequest(new Request('https://worker.example/api/clients/existing/trash-lifecycle', {
      method: 'POST',
      headers: { 'X-API-Key': 'secret' },
    }), env);

    expect(response.status).toBe(200);
    expect(s3ApplyTrashLifecycleRule).toHaveBeenCalledWith('existing-bucket');
    expect(await response.json()).toEqual({ ok: true, bucketName: 'existing-bucket' });
  });

  it('returns 404 for an unknown client and never calls the S3 client', async () => {
    getClient.mockResolvedValue(null);

    const response = await handleRequest(new Request('https://worker.example/api/clients/ghost/trash-lifecycle', {
      method: 'POST',
      headers: { 'X-API-Key': 'secret' },
    }), env);

    expect(response.status).toBe(404);
    expect(s3ApplyTrashLifecycleRule).not.toHaveBeenCalled();
  });

  it('returns 502 when the rule cannot be applied', async () => {
    getClient.mockResolvedValue(existingClient);
    getClientCredentials.mockResolvedValue({ accessKeyId: 'key', secretAccessKey: 'secret' });
    s3ApplyTrashLifecycleRule.mockRejectedValue(new Error('R2 rejected the lifecycle policy'));

    const response = await handleRequest(new Request('https://worker.example/api/clients/existing/trash-lifecycle', {
      method: 'POST',
      headers: { 'X-API-Key': 'secret' },
    }), env);

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'R2 rejected the lifecycle policy' });
  });
});
