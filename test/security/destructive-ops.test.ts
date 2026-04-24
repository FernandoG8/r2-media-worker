import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { AUTH_HEADERS, clientHeaders, clientPayload, uniqueClientId } from '../helpers/factories';
import { activateS3Mock, mockS3GetObject, mockS3Put } from '../helpers/s3-mock';

const PNG_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

async function createProdClient() {
  const id = uniqueClientId('sec-delete-prod');
  const res = await SELF.fetch('https://example.com/api/clients', {
    method: 'POST',
    headers: AUTH_HEADERS,
    body: JSON.stringify(clientPayload(id, { env: 'prod' })),
  });
  expect(res.status).toBe(201);
  return id;
}

async function uploadPng(clientId: string, name: string) {
  mockS3Put();
  const fd = new FormData();
  fd.append('file', new File([PNG_BYTES], name, { type: 'image/png' }));
  const res = await SELF.fetch('https://example.com/api/upload', {
    method: 'POST',
    headers: { 'X-API-Key': 'test-api-secret-xyz', 'X-Client-ID': clientId },
    body: fd,
  });
  expect(res.status).toBe(201);
}

async function expectFileStillReadable(clientId: string, key: string) {
  mockS3GetObject('image/png');
  const res = await SELF.fetch(`https://example.com/file/${encodeURIComponent(clientId)}/${encodeURIComponent(key)}`);
  expect(res.status).toBe(200);
}

describe('confirmación destructiva — integridad [S-W-09..10]', () => {
  it('delete en prod sin X-Confirmed-Name devuelve 412 y el archivo persiste', async () => {
    activateS3Mock();
    const id = await createProdClient();
    await uploadPng(id, 'prod-file.png');

    const del = await SELF.fetch('https://example.com/api/delete?key=prod-file.png', {
      method: 'DELETE',
      headers: clientHeaders(id),
    });

    expect(del.status).toBe(412);
    await expectFileStillReadable(id, 'prod-file.png');
  });

  it('delete en prod con X-Confirmed-Name incorrecto devuelve 412 y el archivo persiste', async () => {
    activateS3Mock();
    const id = await createProdClient();
    await uploadPng(id, 'prod-file-wrong.png');

    const del = await SELF.fetch('https://example.com/api/delete?key=prod-file-wrong.png', {
      method: 'DELETE',
      headers: { ...clientHeaders(id), 'X-Confirmed-Name': 'nombre-incorrecto' },
    });

    expect(del.status).toBe(412);
    await expectFileStillReadable(id, 'prod-file-wrong.png');
  });
});
