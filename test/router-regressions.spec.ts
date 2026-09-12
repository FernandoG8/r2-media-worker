import { beforeEach, describe, expect, it, vi } from 'vitest';

const s3Head = vi.fn();
const s3Copy = vi.fn();
const s3Delete = vi.fn();
const s3Get = vi.fn();

vi.mock('../src/access', () => ({
  verifyAccessJwt: vi.fn(async () => ({ ok: true })),
}));
vi.mock('../src/clients', () => ({
  getClient: vi.fn(async () => ({
    bucketName: 'bucket',
    endpoint: 'https://s3.example',
    config: { env: 'prod' },
    env: 'prod',
  })),
  getClientCredentials: vi.fn(async () => ({ accessKeyId: 'key', secretAccessKey: 'secret' })),
  listClients: vi.fn(),
  createClient: vi.fn(),
  deleteClient: vi.fn(),
  updateClientConfig: vi.fn(),
}));
vi.mock('../src/s3', () => ({
  createS3Client: vi.fn(() => ({
    s3Head,
    s3Copy,
    s3Delete,
    s3Get,
    s3List: vi.fn(),
    s3Put: vi.fn(),
    s3Presign: vi.fn(),
    s3PutBucketCors: vi.fn(),
    s3UpdateMetadata: vi.fn(),
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

beforeEach(() => {
  vi.clearAllMocks();
  s3Head.mockResolvedValue(new Response(null, { status: 200 }));
  s3Copy.mockResolvedValue(undefined);
  s3Delete.mockResolvedValue(undefined);
});

describe('media route regressions', () => {
  it('preserves object cache metadata and uses a conservative fallback', async () => {
    s3Get.mockResolvedValueOnce(new Response('image', {
      status: 200,
      headers: {
        'content-type': 'image/webp',
        'cache-control': 'private, max-age=60',
        'content-disposition': 'inline',
      },
    }));
    const preserved = await handleRequest(new Request(
      'https://worker.example/file/client/gallery/image.webp',
    ), env);
    expect(preserved.status).toBe(200);
    expect(preserved.headers.get('cache-control')).toBe('private, max-age=60');
    expect(preserved.headers.get('content-disposition')).toBe('inline');

    s3Get.mockResolvedValueOnce(new Response('image', { status: 200 }));
    const fallback = await handleRequest(new Request(
      'https://worker.example/file/client/gallery/no-cache.webp',
    ), env);
    expect(fallback.headers.get('cache-control')).toBe('public, max-age=3600');
  });

});
