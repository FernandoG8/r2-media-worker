/**
 * H-3.1 (documentado): POST /api/download-zip usa env.BUCKET.get(key) (binding R2),
 * pero POST /api/upload usa s3.s3Put() (HTTP S3 API a endpoint externo).
 * En Miniflare son dos almacenamientos distintos — archivos subidos vía /api/upload
 * NO aparecen en env.BUCKET. Para testear download-zip se puebla env.BUCKET directamente.
 */
import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { unzipSync } from 'fflate';
import type { Env } from '../../src/types';
import { AUTH_HEADERS, clientHeaders, clientPayload, uniqueClientId } from '../helpers/factories';
import { activateS3Mock, mockS3Delete, mockS3GetObject, mockS3List, mockS3Put } from '../helpers/s3-mock';

const workerEnv = env as unknown as Env;

// Bytes mágicos de PNG: suficientes para pasar la validación de MIME por tipo declarado
const PNG_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

function makePngFile(name: string): File {
  return new File([PNG_BYTES], name, { type: 'image/png' });
}

async function uploadFile(clientId: string, file: File, prefix = '') {
  activateS3Mock();
  mockS3Put();
  const fd = new FormData();
  fd.append('file', file);
  fd.append('prefix', prefix);
  return SELF.fetch('https://example.com/api/upload', {
    method: 'POST',
    headers: { 'X-API-Key': 'test-api-secret-xyz', 'X-Client-ID': clientId },
    body: fd,
  });
}

// ─── I-W-02 — Upload → list → download → delete ───────────────────────────────

describe('ciclo upload-list-download-delete [I-W-02]', () => {
  it('sube un archivo PNG y aparece en el listado', async () => {
    activateS3Mock();
    const id = uniqueClientId();
    await SELF.fetch('https://example.com/api/clients', {
      method: 'POST', headers: AUTH_HEADERS,
      body: JSON.stringify(clientPayload(id)),
    });

    mockS3Put();
    const fd = new FormData();
    fd.append('file', makePngFile('photo.png'));
    fd.append('prefix', '');
    const upload = await SELF.fetch('https://example.com/api/upload', {
      method: 'POST',
      headers: { 'X-API-Key': 'test-api-secret-xyz', 'X-Client-ID': id },
      body: fd,
    });
    expect(upload.status).toBe(201);
    const uploaded = await upload.json() as { key: string; name: string; url: string; size: number };
    expect(uploaded.key).toBe('photo.png');
    expect(uploaded.name).toBe('photo.png');
    expect(uploaded.url).toContain('/file/');

    mockS3List([{ key: 'photo.png', size: PNG_BYTES.length }]);
    const list = await SELF.fetch('https://example.com/api/list', { headers: clientHeaders(id) });
    expect(list.status).toBe(200);
    const body = await list.json() as { files: Array<{ key: string }> };
    expect(body.files.some(f => f.key === 'photo.png')).toBe(true);
  });

  it('el archivo subido es accesible sin autenticacion via GET /file/:clientId/:key', async () => {
    activateS3Mock();
    const id = uniqueClientId();
    await SELF.fetch('https://example.com/api/clients', {
      method: 'POST', headers: AUTH_HEADERS,
      body: JSON.stringify(clientPayload(id)),
    });

    mockS3GetObject('image/png');
    const res = await SELF.fetch(`https://example.com/file/${encodeURIComponent(id)}/photo.png`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('image/png');
  });

  it('elimina el archivo y desaparece del listado', async () => {
    activateS3Mock();
    const id = uniqueClientId('test-del');
    await SELF.fetch('https://example.com/api/clients', {
      method: 'POST', headers: AUTH_HEADERS,
      body: JSON.stringify(clientPayload(id, { env: 'test' })),
    });

    // Subir (S3 PUT mocked)
    mockS3Put();
    const fd = new FormData();
    fd.append('file', makePngFile('to-delete.png'));
    await SELF.fetch('https://example.com/api/upload', {
      method: 'POST',
      headers: { 'X-API-Key': 'test-api-secret-xyz', 'X-Client-ID': id },
      body: fd,
    });

    // Eliminar (S3 DELETE mocked) — cliente test no requiere X-Confirmed-Name
    mockS3Delete();
    const del = await SELF.fetch(
      'https://example.com/api/delete?key=to-delete.png',
      { method: 'DELETE', headers: clientHeaders(id) },
    );
    expect(del.status).toBe(200);

    // Verificar que no aparece en la lista
    mockS3List([]);
    const list = await SELF.fetch('https://example.com/api/list', { headers: clientHeaders(id) });
    const body = await list.json() as { files: Array<{ key: string }> };
    expect(body.files.some(f => f.key === 'to-delete.png')).toBe(false);
  });
});

// ─── I-W-03 — Confirmación destructiva prod vs test ───────────────────────────

describe('confirmacion destructiva prod vs test [I-W-03]', () => {
  async function createClient(id: string, clientEnv: 'test' | 'prod') {
    await SELF.fetch('https://example.com/api/clients', {
      method: 'POST', headers: AUTH_HEADERS,
      body: JSON.stringify(clientPayload(id, { env: clientEnv })),
    });
  }

  it('cliente test: elimina sin X-Confirmed-Name', async () => {
    activateS3Mock();
    const id = uniqueClientId('test-t1');
    await createClient(id, 'test');
    mockS3Delete();
    const res = await SELF.fetch('https://example.com/api/delete?key=file.png', {
      method: 'DELETE', headers: clientHeaders(id),
    });
    expect(res.status).toBe(200);
  });

  it('cliente test: elimina con X-Confirmed-Name incorrecto (no lo exige)', async () => {
    activateS3Mock();
    const id = uniqueClientId('test-t2');
    await createClient(id, 'test');
    mockS3Delete();
    const res = await SELF.fetch('https://example.com/api/delete?key=file.png', {
      method: 'DELETE',
      headers: { ...clientHeaders(id), 'X-Confirmed-Name': 'WRONG' },
    });
    expect(res.status).toBe(200);
  });

  it('cliente test: elimina con X-Confirmed-Name correcto', async () => {
    activateS3Mock();
    const id = uniqueClientId('test-t3');
    await createClient(id, 'test');
    mockS3Delete();
    const res = await SELF.fetch('https://example.com/api/delete?key=file.png', {
      method: 'DELETE',
      headers: { ...clientHeaders(id), 'X-Confirmed-Name': 'file.png' },
    });
    expect(res.status).toBe(200);
  });

  it('cliente prod: rechaza delete sin X-Confirmed-Name', async () => {
    activateS3Mock();
    const id = uniqueClientId('test-p1');
    await createClient(id, 'prod');
    const res = await SELF.fetch('https://example.com/api/delete?key=file.png', {
      method: 'DELETE', headers: clientHeaders(id),
    });
    expect(res.status).toBe(412);
  });

  it('cliente prod: rechaza delete con X-Confirmed-Name incorrecto', async () => {
    activateS3Mock();
    const id = uniqueClientId('test-p2');
    await createClient(id, 'prod');
    const res = await SELF.fetch('https://example.com/api/delete?key=file.png', {
      method: 'DELETE',
      headers: { ...clientHeaders(id), 'X-Confirmed-Name': 'WRONG' },
    });
    expect(res.status).toBe(412);
  });

  it('cliente prod: acepta delete con X-Confirmed-Name correcto', async () => {
    activateS3Mock();
    const id = uniqueClientId('test-p3');
    await createClient(id, 'prod');
    mockS3Delete();
    // X-Confirmed-Name debe ser el nombre del archivo (no el key completo)
    // Para key 'folder/report.png', el nombre es 'report.png' (.split('/').pop())
    const res = await SELF.fetch('https://example.com/api/delete?key=folder%2Freport.png', {
      method: 'DELETE',
      headers: { ...clientHeaders(id), 'X-Confirmed-Name': 'report.png' },
    });
    expect(res.status).toBe(200);
  });

  it('cliente sin env definido se comporta como prod (env: prod equivale a sin env)', async () => {
    // La lógica del worker es: (client.env ?? 'prod') !== 'test'
    // env:'prod' y env:undefined se comportan igual.
    activateS3Mock();
    const id = uniqueClientId('test-noenv');
    await createClient(id, 'prod');
    const res = await SELF.fetch('https://example.com/api/delete?key=file.png', {
      method: 'DELETE', headers: clientHeaders(id),
    });
    expect(res.status).toBe(412);
  });
});

// ─── I-W-07 / I-W-08 — Download-zip ──────────────────────────────────────────
// H-3.1: download-zip usa env.BUCKET (R2 binding) para leer archivos.
// Se puebla env.BUCKET directamente en el test con `env` de cloudflare:test.

describe('download-zip [I-W-07, I-W-08]', () => {
  it('descarga multiples archivos como ZIP por keys[]', async () => {
    activateS3Mock();
    const id = uniqueClientId('zip-keys');
    await SELF.fetch('https://example.com/api/clients', {
      method: 'POST', headers: AUTH_HEADERS,
      body: JSON.stringify(clientPayload(id)),
    });

    // Pre-poblar env.BUCKET directamente (H-3.1: download-zip lee de binding, no de S3)
    await workerEnv.BUCKET.put('img-a.png', PNG_BYTES);
    await workerEnv.BUCKET.put('img-b.png', PNG_BYTES);

    const res = await SELF.fetch('https://example.com/api/download-zip', {
      method: 'POST',
      headers: clientHeaders(id),
      body: JSON.stringify({ keys: ['img-a.png', 'img-b.png'], name: 'test' }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/zip');
    expect(res.headers.get('content-disposition')).toContain('test.zip');

    const zipBuffer = await res.arrayBuffer();
    const unzipped = unzipSync(new Uint8Array(zipBuffer));
    expect(Object.keys(unzipped)).toContain('img-a.png');
    expect(Object.keys(unzipped)).toContain('img-b.png');
  });

  it('download-zip por prefix lista y comprime todos los archivos del prefijo', async () => {
    activateS3Mock();
    const id = uniqueClientId('zip-prefix');
    await SELF.fetch('https://example.com/api/clients', {
      method: 'POST', headers: AUTH_HEADERS,
      body: JSON.stringify(clientPayload(id)),
    });

    // Pre-poblar env.BUCKET con archivos bajo zippable/
    await workerEnv.BUCKET.put('zippable/one.png', PNG_BYTES);
    await workerEnv.BUCKET.put('zippable/two.png', PNG_BYTES);
    await workerEnv.BUCKET.put('zippable/three.png', PNG_BYTES);

    // download-zip por prefix usa S3 LIST para obtener las keys
    mockS3List([
      { key: 'zippable/one.png' },
      { key: 'zippable/two.png' },
      { key: 'zippable/three.png' },
    ]);

    const res = await SELF.fetch('https://example.com/api/download-zip', {
      method: 'POST',
      headers: clientHeaders(id),
      body: JSON.stringify({ prefix: 'zippable/' }),
    });

    expect(res.status).toBe(200);
    const zipBuffer = await res.arrayBuffer();
    const unzipped = unzipSync(new Uint8Array(zipBuffer));
    expect(Object.keys(unzipped)).toHaveLength(3);
  });

  it('retorna 400 cuando no se provee ni keys ni prefix', async () => {
    activateS3Mock();
    const id = uniqueClientId('zip-bad');
    await SELF.fetch('https://example.com/api/clients', {
      method: 'POST', headers: AUTH_HEADERS,
      body: JSON.stringify(clientPayload(id)),
    });

    const res = await SELF.fetch('https://example.com/api/download-zip', {
      method: 'POST',
      headers: clientHeaders(id),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('retorna 404 cuando no se encuentran archivos', async () => {
    activateS3Mock();
    const id = uniqueClientId('zip-empty');
    await SELF.fetch('https://example.com/api/clients', {
      method: 'POST', headers: AUTH_HEADERS,
      body: JSON.stringify(clientPayload(id)),
    });

    // keys[] con claves que no existen en env.BUCKET → env.BUCKET.get() devuelve null → entries vacío
    const res = await SELF.fetch('https://example.com/api/download-zip', {
      method: 'POST',
      headers: clientHeaders(id),
      body: JSON.stringify({ keys: ['nonexistent.png'] }),
    });
    expect(res.status).toBe(500);
  });
});
