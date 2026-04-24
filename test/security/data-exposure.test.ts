import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { AUTH_HEADERS, clientHeaders, clientPayload, uniqueClientId } from '../helpers/factories';
import { activateS3Mock, mockS3List } from '../helpers/s3-mock';

async function createClient(overrides: Record<string, unknown> = {}) {
  const id = uniqueClientId('sec-exposure');
  const res = await SELF.fetch('https://example.com/api/clients', {
    method: 'POST',
    headers: AUTH_HEADERS,
    body: JSON.stringify(clientPayload(id, overrides)),
  });
  expect(res.status).toBe(201);
  return id;
}

async function responseBodyAsString(res: Response): Promise<string> {
  const text = await res.text();
  try {
    return JSON.stringify(JSON.parse(text));
  } catch {
    return text;
  }
}

describe('no filtración de credenciales en tránsito [S-W-04..05]', () => {
  it('GET /api/clients no incluye accessKeyId ni secretAccessKey en la respuesta', async () => {
    await createClient({ accessKeyId: 'AKIAIOSFODNN7EXAMPLE' });

    const res = await SELF.fetch('https://example.com/api/clients', { headers: AUTH_HEADERS });
    expect(res.status).toBe(200);
    const serialized = await responseBodyAsString(res);

    expect(serialized).not.toContain('accessKeyId');
    expect(serialized).not.toContain('secretAccessKey');
    expect(serialized).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });

  it.each([
    { method: 'GET', path: '/api/clients', setup: false },
    { method: 'GET', path: '/api/list', setup: true },
    { method: 'GET', path: '/api/folders', setup: true },
    { method: 'POST', path: '/api/download-zip', setup: true, body: JSON.stringify({ keys: [] }) },
    { method: 'POST', path: '/api/upload', setup: true, body: '{}', contentType: 'application/json' },
    { method: 'POST', path: '/api/rename', setup: true, body: JSON.stringify({}) },
    { method: 'POST', path: '/api/folder', setup: true, body: JSON.stringify({}) },
    { method: 'POST', path: '/api/delete-recursive', setup: true, body: JSON.stringify({}) },
    { method: 'POST', path: '/api/rename-folder', setup: true, body: JSON.stringify({}) },
    { method: 'POST', path: '/api/update-cache-header', setup: true, body: JSON.stringify({}) },
  ])(
    'ningún endpoint devuelve credenciales descifradas: $method $path',
    async ({ method, path, setup, body, contentType }) => {
      const clientId = await createClient();
      const headers = setup
        ? { ...clientHeaders(clientId), ...(contentType ? { 'Content-Type': contentType } : {}) }
        : AUTH_HEADERS;

      if (path === '/api/list' || path === '/api/folders') {
        activateS3Mock();
        mockS3List([]);
      }

      const res = await SELF.fetch(`https://example.com${path}`, {
        method,
        headers,
        body,
      });
      expect(res.status).not.toBe(401);
      const serialized = await responseBodyAsString(res);

      expect(serialized).not.toContain('accessKeyId');
      expect(serialized).not.toContain('secretAccessKey');
    },
  );
});
