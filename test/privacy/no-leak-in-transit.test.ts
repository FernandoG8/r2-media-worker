import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { AUTH_HEADERS, clientHeaders, clientPayload, uniqueClientId } from '../helpers/factories';

const UNIQUE_ACCESS_KEY = 'UNIQUE-KEY-XYZ-PRIVACY-TEST';
const UNIQUE_SECRET_KEY = 'UNIQUE-SECRET-XYZ-PRIVACY-TEST';

async function createClient(overrides: Record<string, unknown> = {}) {
  const id = uniqueClientId('priv-transit');
  const res = await SELF.fetch('https://example.com/api/clients', {
    method: 'POST',
    headers: AUTH_HEADERS,
    body: JSON.stringify(clientPayload(id, overrides)),
  });
  expect(res.status).toBe(201);
  return id;
}

function collectJsonKeys(value: unknown, keys = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectJsonKeys(item, keys);
  } else if (value && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      keys.add(key);
      collectJsonKeys(nested, keys);
    }
  }
  return keys;
}

describe('credenciales no filtradas en tránsito [P-W-04..06]', () => {
  it('GET /api/clients no filtra accessKeyId ni secretAccessKey como campos JSON', async () => {
    await createClient({
      accessKeyId: UNIQUE_ACCESS_KEY,
      secretAccessKey: UNIQUE_SECRET_KEY,
    });

    const res = await SELF.fetch('https://example.com/api/clients', { headers: AUTH_HEADERS });
    expect(res.status).toBe(200);
    const body = await res.json();
    const keys = collectJsonKeys(body);

    expect(keys.has('accessKeyId')).toBe(false);
    expect(keys.has('secretAccessKey')).toBe(false);
  });

  it('GET /api/clients no filtra los VALORES de las credenciales en ningún campo', async () => {
    await createClient({
      accessKeyId: UNIQUE_ACCESS_KEY,
      secretAccessKey: UNIQUE_SECRET_KEY,
    });

    const res = await SELF.fetch('https://example.com/api/clients', { headers: AUTH_HEADERS });
    expect(res.status).toBe(200);
    const serialized = JSON.stringify(await res.json());

    expect(serialized).not.toContain(UNIQUE_ACCESS_KEY);
    expect(serialized).not.toContain(UNIQUE_SECRET_KEY);
  });

  it('respuesta de error 500 no expone internals', async () => {
    const id = await createClient();
    const res = await SELF.fetch('https://example.com/api/rename', {
      method: 'POST',
      headers: clientHeaders(id),
      body: '',
    });
    const body = await res.text();

    // No hay un 500 limpio sin mutar bindings; este 500 controlado viene del
    // try/catch global por body JSON vacio y valida que no se exponga stack.
    expect(res.status).toBe(500);
    expect(body).not.toContain('Error:');
    expect(body).not.toMatch(/\bat\s+.*\.(ts|js):\d+:\d+/);
    expect(body).not.toContain('MASTER_KEY');
    expect(body).not.toContain('API_SECRET');
    expect(body).not.toContain(UNIQUE_ACCESS_KEY);
    expect(body).not.toContain(UNIQUE_SECRET_KEY);
  });
});
