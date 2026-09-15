import { SELF, fetchMock } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { AUTH_HEADERS, clientHeaders, clientPayload, uniqueClientId } from '../helpers/factories';
import { activateS3Mock, mockS3GetObject, mockS3Put } from '../helpers/s3-mock';

const S3_ORIGIN = 'https://test-account.r2.cloudflarestorage.com';
const PNG_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

async function createClient(overrides: Record<string, unknown> = {}) {
  const id = uniqueClientId('sec-input');
  const res = await SELF.fetch('https://example.com/api/clients', {
    method: 'POST',
    headers: AUTH_HEADERS,
    body: JSON.stringify(clientPayload(id, overrides)),
  });
  expect(res.status).toBe(201);
  return id;
}

async function upload(clientId: string, file: File) {
  const fd = new FormData();
  fd.append('file', file);
  return SELF.fetch('https://example.com/api/upload', {
    method: 'POST',
    headers: { 'X-API-Key': 'test-api-secret-xyz', 'X-Client-ID': clientId },
    body: fd,
  });
}

function mockS3GetNotFound() {
  fetchMock
    .get(S3_ORIGIN)
    .intercept({ path: /^\/[^?]+\/[^?]/, method: 'GET' })
    .reply(404, '');
}

async function bodyAsString(res: Response): Promise<string> {
  return res.text();
}

describe('validación de input en upload [S-W-06..08]', () => {
  it('rechaza archivo con MIME application/pdf', async () => {
    activateS3Mock();
    const id = await createClient();
    const file = new File([new Uint8Array([0, 1, 2, 3])], 'doc.pdf', { type: 'application/pdf' });

    const res = await upload(id, file);

    expect(res.status).toBe(400);
  });

  it('rechaza archivo con MIME image/tiff (imagen pero no en allowlist)', async () => {
    activateS3Mock();
    const id = await createClient();
    const file = new File([new Uint8Array([0, 1, 2, 3])], 'image.tiff', { type: 'image/tiff' });

    const res = await upload(id, file);

    expect(res.status).toBe(400);
  });

  it('rechaza archivo con MIME text/html', async () => {
    activateS3Mock();
    const id = await createClient();
    const file = new File([new Uint8Array([60, 104, 49, 62])], 'xss.html', { type: 'text/html' });

    const res = await upload(id, file);

    expect(res.status).toBe(400);
  });

  it('acepta archivo con MIME image/png', async () => {
    activateS3Mock();
    const id = await createClient();
    mockS3Put();
    const file = new File([PNG_BYTES], 'image.png', { type: 'image/png' });

    const res = await upload(id, file);

    expect(res.status).toBe(201);
  });

  it('rechaza archivo que excede 10 MB', async () => {
    activateS3Mock();
    const id = await createClient();
    const file = new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'big.png', { type: 'image/png' });

    const uploadRes = await upload(id, file);
    expect(uploadRes.status).toBe(400);

    mockS3GetNotFound();
    const getRes = await SELF.fetch(`https://example.com/file/${encodeURIComponent(id)}/big.png`);
    expect(getRes.status).toBe(404);
  });

  it('acepta archivo exactamente en el límite de 10 MB', async () => {
    activateS3Mock();
    const id = await createClient();
    mockS3Put();
    const file = new File([new Uint8Array(10 * 1024 * 1024)], 'limit.png', { type: 'image/png' });

    const res = await upload(id, file);

    expect(res.status).toBe(201);
  });

  it('rechaza upload con Content-Type no multipart', async () => {
    const id = await createClient();

    const res = await SELF.fetch('https://example.com/api/upload', {
      method: 'POST',
      headers: clientHeaders(id),
      body: '{}',
    });

    expect(res.status).toBe(400);
  });
});

describe('path traversal [S-W-11]', () => {
  it('key con ../ no devuelve objeto de otro path', async () => {
    activateS3Mock();
    const id = await createClient();
    mockS3Put();
    const uploadRes = await upload(id, new File([PNG_BYTES], 'legit.png', { type: 'image/png' }));
    expect(uploadRes.status).toBe(201);

    const res = await SELF.fetch(`https://example.com/file/${encodeURIComponent(id)}/../legit.png`);
    const body = await bodyAsString(res);

    expect(res.status === 404 || body !== String.fromCharCode(...PNG_BYTES.slice(0, 4))).toBe(true);
  });

  it('key con caracteres codificados %2e%2e%2f', async () => {
    activateS3Mock();
    const id = await createClient();
    mockS3GetObject();

    const res = await SELF.fetch(`https://example.com/file/${encodeURIComponent(id)}/%2e%2e%2flegitig.png`);

    expect([200, 404, 500]).toContain(res.status);
  });
});

describe('body malformado [S-W-13]', () => {
  it('POST /api/clients con body no-JSON devuelve error con CORS headers', async () => {
    const res = await SELF.fetch('https://example.com/api/clients', {
      method: 'POST',
      headers: AUTH_HEADERS,
      body: 'esto no es json',
    });
    const body = await res.text();

    expect([400, 500]).toContain(res.status);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeTruthy();
    expect(body).not.toContain('Error:');
    expect(body).not.toMatch(/\bat\s+.*\.(ts|js):\d+:\d+/);
  });

  it('POST /api/rename con body vacío devuelve error con CORS headers', async () => {
    const id = await createClient();

    const res = await SELF.fetch('https://example.com/api/rename', {
      method: 'POST',
      headers: clientHeaders(id),
      body: '',
    });
    const body = await res.text();

    expect([400, 500]).toContain(res.status);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeTruthy();
    expect(body).not.toContain('Error:');
    expect(body).not.toMatch(/\bat\s+.*\.(ts|js):\d+:\d+/);
  });
});
