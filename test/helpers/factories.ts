import type { Env } from '../../src/types';

// Augment cloudflare:test so env.CLIENTS_KV, env.BUCKET, etc. are typed.
declare module 'cloudflare:test' {
  interface ProvidedEnv extends Env {}
}

export function uniqueClientId(prefix = 'test-client'): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}

export function clientPayload(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: `Test Client ${id}`,
    bucketName: 'test-bucket',
    endpoint: 'https://test-account.r2.cloudflarestorage.com',
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    r2BaseUrl: '',
    env: 'test' as const,
    ...overrides,
  };
}

// Must match API_SECRET in vitest.config.mts miniflare.bindings
export const AUTH_HEADERS = {
  'X-API-Key': 'test-api-secret-xyz',
  'Content-Type': 'application/json',
};

export function clientHeaders(clientId: string) {
  return {
    ...AUTH_HEADERS,
    'X-Client-ID': clientId,
  };
}
