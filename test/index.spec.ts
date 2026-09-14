import { describe, it, expect } from 'vitest';
import { handleRequest } from '../src/router';
import type { Env } from '../src/types';

const baseEnv = {
  ALLOWED_ORIGIN: 'https://panel-v2.mizcor.dev',
  TEAM_DOMAIN: 'https://example.cloudflareaccess.com',
  POLICY_AUD: 'test-audience',
  ACCESS_ENFORCEMENT: 'enabled',
} as Env;

describe('Worker security boundary — ACCESS_ENFORCEMENT=enabled', () => {
  it('rejects private API routes before reading client or R2 state', async () => {
    const response = await handleRequest(
      new Request('https://worker.example/api/list', {
        headers: { Origin: 'https://panel-v2.mizcor.dev' },
      }),
      baseEnv,
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'Access token is missing or invalid' });
    expect(response.headers.get('Access-Control-Allow-Credentials')).toBe('true');
  });

  it('fails closed when the Access configuration is absent', async () => {
    const response = await handleRequest(
      new Request('https://worker.example/api/clients'),
      { ...baseEnv, TEAM_DOMAIN: '', POLICY_AUD: '' },
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'Access configuration is missing or invalid' });
  });

  it('answers browser preflight without requiring an Access assertion', async () => {
    const response = await handleRequest(
      new Request('https://worker.example/api/list', {
        method: 'OPTIONS',
        headers: { Origin: 'https://panel-v2.mizcor.dev' },
      }),
      baseEnv,
    );

    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://panel-v2.mizcor.dev');
    expect(response.headers.get('Access-Control-Allow-Credentials')).toBe('true');
  });

  it('does not expose unknown non-API routes', async () => {
    const response = await handleRequest(new Request('https://worker.example/private'), baseEnv);
    expect(response.status).toBe(404);
  });
});

describe('Worker security boundary — ACCESS_ENFORCEMENT suspended (default)', () => {
  const fakeKv = {
    get: async () => null,
    put: async () => undefined,
    delete: async () => undefined,
  } as unknown as KVNamespace;

  const suspendedEnv = {
    ...baseEnv,
    ACCESS_ENFORCEMENT: 'suspended',
    API_SECRET: 'top-secret',
    CLIENTS_KV: fakeKv,
  } as Env;

  it('does not require an Access assertion, but still requires X-API-Key (401 without it)', async () => {
    const response = await handleRequest(
      new Request('https://worker.example/api/clients', {
        headers: { Origin: 'https://panel-v2.mizcor.dev' },
      }),
      suspendedEnv,
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Unauthorized' });
  });

  it('proceeds past the Access gate to normal X-API-Key handling with a valid key', async () => {
    const response = await handleRequest(
      new Request('https://worker.example/api/clients', {
        headers: { Origin: 'https://panel-v2.mizcor.dev', 'X-API-Key': 'top-secret' },
      }),
      suspendedEnv,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
  });

  it('also suspends enforcement when ACCESS_ENFORCEMENT is absent entirely', async () => {
    const { ACCESS_ENFORCEMENT: _omit, ...withoutFlag } = suspendedEnv as Record<string, unknown>;
    const response = await handleRequest(
      new Request('https://worker.example/api/clients', {
        headers: { Origin: 'https://panel-v2.mizcor.dev' },
      }),
      withoutFlag as Env,
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Unauthorized' });
  });
});
