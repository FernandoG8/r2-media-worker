import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { AUTH_HEADERS, clientHeaders, clientPayload, uniqueClientId } from '../helpers/factories';
import { activateS3Mock, mockS3Delete, mockS3List, mockS3Put } from '../helpers/s3-mock';

const PNG_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

async function createTestClient(id: string) {
  return SELF.fetch('https://example.com/api/clients', {
    method: 'POST', headers: AUTH_HEADERS,
    body: JSON.stringify(clientPayload(id, { env: 'test' })),
  });
}

// ─── I-W-04 — Rename de archivo ───────────────────────────────────────────────

describe('rename de archivo [I-W-04]', () => {
  it('renombra un archivo: aparece con el nuevo key y desaparece del anterior', async () => {
    activateS3Mock();
    const id = uniqueClientId('ren-file');
    await createTestClient(id);

    // 1. Subir original.png
    mockS3Put(); // S3 PUT para upload
    const fd = new FormData();
    fd.append('file', new File([PNG_BYTES], 'original.png', { type: 'image/png' }));
    await SELF.fetch('https://example.com/api/upload', {
      method: 'POST',
      headers: { 'X-API-Key': 'test-api-secret-xyz', 'X-Client-ID': id },
      body: fd,
    });

    // 2. Renombrar: COPY (PUT) + DELETE
    mockS3Put(); // S3 PUT para copy
    mockS3Delete(); // S3 DELETE para eliminar original
    const rename = await SELF.fetch('https://example.com/api/rename', {
      method: 'POST',
      headers: clientHeaders(id),
      body: JSON.stringify({ sourceKey: 'original.png', destKey: 'renamed.png' }),
    });
    expect(rename.status).toBe(200);
    const renameBody = await rename.json() as { ok: boolean; newKey: string };
    expect(renameBody.ok).toBe(true);
    expect(renameBody.newKey).toBe('renamed.png');

    // 3. Lista debe mostrar renamed.png, no original.png
    mockS3List([{ key: 'renamed.png' }]);
    const list = await SELF.fetch('https://example.com/api/list', { headers: clientHeaders(id) });
    const listBody = await list.json() as { files: Array<{ key: string }> };
    expect(listBody.files.some(f => f.key === 'renamed.png')).toBe(true);
    expect(listBody.files.some(f => f.key === 'original.png')).toBe(false);
  });
});

// ─── I-W-05 — Rename de carpeta ───────────────────────────────────────────────

describe('rename de carpeta [I-W-05]', () => {
  it('renombra carpeta con multiples archivos: todos migran al nuevo prefijo', async () => {
    activateS3Mock();
    const id = uniqueClientId('ren-folder');
    await createTestClient(id);

    // La operación rename-folder hace:
    // 1 LIST (galeria/) + 3 COPY (PUT) + 3 DELETE + 1 PUT (nueva carpeta) + 1 DELETE (carpeta vieja)
    mockS3List([
      { key: 'galeria/foto1.png' },
      { key: 'galeria/foto2.png' },
      { key: 'galeria/foto3.png' },
    ]);
    mockS3Put(4);    // 3 copies + 1 folder marker
    mockS3Delete(4); // 3 file deletes + 1 old folder marker (try/catch)

    const rename = await SELF.fetch('https://example.com/api/rename-folder', {
      method: 'POST',
      headers: clientHeaders(id),
      body: JSON.stringify({ oldPrefix: 'galeria/', newPrefix: 'fotos/' }),
    });
    expect(rename.status).toBe(200);
    const body = await rename.json() as { ok: boolean; moved: number };
    expect(body.ok).toBe(true);
    expect(body.moved).toBe(3);

    // Verificar estado post-rename con mocks de list
    mockS3List([
      { key: 'fotos/foto1.png' },
      { key: 'fotos/foto2.png' },
      { key: 'fotos/foto3.png' },
    ]);
    const listNew = await SELF.fetch('https://example.com/api/list?prefix=fotos%2F', {
      headers: clientHeaders(id),
    });
    const newBody = await listNew.json() as { files: Array<{ key: string }> };
    expect(newBody.files).toHaveLength(3);

    mockS3List([]);
    const listOld = await SELF.fetch('https://example.com/api/list?prefix=galeria%2F', {
      headers: clientHeaders(id),
    });
    const oldBody = await listOld.json() as { files: unknown[] };
    expect(oldBody.files).toHaveLength(0);
  });
});

// ─── I-W-06 — Delete-recursive ────────────────────────────────────────────────

describe('delete-recursive [I-W-06]', () => {
  it('elimina carpeta completa con N archivos (cliente test)', async () => {
    activateS3Mock();
    const id = uniqueClientId('del-rec');
    await createTestClient(id);

    // delete-recursive: 1 LIST + 4 DELETE (archivos) + 1 DELETE (carpeta)
    mockS3List([
      { key: 'temp/a.png' },
      { key: 'temp/b.png' },
      { key: 'temp/c.png' },
      { key: 'temp/d.png' },
    ]);
    mockS3Delete(5); // 4 archivos + 1 carpeta marker (try/catch — puede fallar sin romper)

    const del = await SELF.fetch('https://example.com/api/delete-recursive', {
      method: 'POST',
      headers: clientHeaders(id),
      body: JSON.stringify({ prefix: 'temp/' }),
    });
    expect(del.status).toBe(200);
    const body = await del.json() as { ok: boolean; deleted: number };
    expect(body.ok).toBe(true);
    expect(body.deleted).toBe(4);

    // Verificar lista vacía post-eliminación
    mockS3List([]);
    const list = await SELF.fetch('https://example.com/api/list?prefix=temp%2F', {
      headers: clientHeaders(id),
    });
    const listBody = await list.json() as { files: unknown[] };
    expect(listBody.files).toHaveLength(0);
  });
});

// ─── I-W-10 — Creación de carpeta ────────────────────────────────────────────

describe('creacion de carpeta [I-W-10]', () => {
  it('crea una carpeta y aparece en /api/list como folder', async () => {
    activateS3Mock();
    const id = uniqueClientId('folder-create');
    await createTestClient(id);

    // POST /api/folder usa s3.s3Put para crear el folder marker
    mockS3Put();
    const create = await SELF.fetch('https://example.com/api/folder', {
      method: 'POST',
      headers: clientHeaders(id),
      body: JSON.stringify({ path: 'nueva-carpeta' }),
    });
    expect(create.status).toBe(201);
    const body = await create.json() as { key: string };
    expect(body.key).toBe('nueva-carpeta/');

    // El folder aparece en el listado
    mockS3List([], ['nueva-carpeta/']);
    const list = await SELF.fetch('https://example.com/api/list', { headers: clientHeaders(id) });
    const listBody = await list.json() as { folders: Array<{ key: string }> };
    expect(listBody.folders.some(f => f.key === 'nueva-carpeta/')).toBe(true);
  });

  it('crea una carpeta y aparece en /api/folders (lista recursiva)', async () => {
    activateS3Mock();
    const id = uniqueClientId('folder-recursive');
    await createTestClient(id);

    mockS3Put();
    await SELF.fetch('https://example.com/api/folder', {
      method: 'POST',
      headers: clientHeaders(id),
      body: JSON.stringify({ path: 'docs' }),
    });

    // /api/folders hace un LIST recursivo: primero con prefix='' (devuelve 'docs/'),
    // luego con prefix='docs/' (devuelve vacío — sin sub-carpetas).
    mockS3List([], ['docs/']);  // primer LIST: raíz → encuentra docs/
    mockS3List([]);             // segundo LIST: bajo docs/ → sin más carpetas
    const res = await SELF.fetch('https://example.com/api/folders', { headers: clientHeaders(id) });
    expect(res.status).toBe(200);
    const body = await res.json() as { folders: string[] };
    expect(body.folders).toContain('docs/');
  });
});
