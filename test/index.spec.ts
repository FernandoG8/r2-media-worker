import { describe, it, expect } from 'vitest';
import { handleRequest } from '../src/router';
import type { Env } from '../src/types';

const baseEnv = {
  ALLOWED_ORIGIN: 'https://panel-v2.mizcor.dev',
  TEAM_DOMAIN: 'https://example.cloudflareaccess.com',
  POLICY_AUD: 'test-audience',
} as Env;

describe('Worker security boundary', () => {
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
