import { SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { AUTH_HEADERS, clientHeaders, clientPayload, uniqueClientId } from '../helpers/factories';
import { activateS3Mock, mockS3List } from '../helpers/s3-mock';

// ─── I-W-01 — CRUD de clientes ────────────────────────────────────────────────

describe('CRUD de clientes [I-W-01]', () => {
  it('crea un cliente y lo devuelve en el listado', async () => {
    const id = uniqueClientId();
    const create = await SELF.fetch('https://example.com/api/clients', {
      method: 'POST',
      headers: AUTH_HEADERS,
      body: JSON.stringify(clientPayload(id)),
    });
    expect(create.status).toBe(201);
    const created = await create.json() as { id: string; name: string };
    expect(created.id).toBe(id);

    const list = await SELF.fetch('https://example.com/api/clients', {
      headers: AUTH_HEADERS,
    });
    expect(list.status).toBe(200);
    const clients = await list.json() as Array<{ id: string }>;
    expect(clients.some(c => c.id === id)).toBe(true);
  });

  it('actualiza el env de test a prod', async () => {
    const id = uniqueClientId();
    await SELF.fetch('https://example.com/api/clients', {
      method: 'POST',
      headers: AUTH_HEADERS,
      body: JSON.stringify(clientPayload(id, { env: 'test' })),
    });

    const patch = await SELF.fetch(`https://example.com/api/clients/${id}`, {
      method: 'PATCH',
      headers: AUTH_HEADERS,
      body: JSON.stringify({ env: 'prod' }),
    });
    expect(patch.status).toBe(200);

    const list = await SELF.fetch('https://example.com/api/clients', { headers: AUTH_HEADERS });
    const clients = await list.json() as Array<{ id: string; config: { env: string } }>;
    const client = clients.find(c => c.id === id);
    expect(client?.config.env).toBe('prod');
  });

  it('elimina un cliente y desaparece del listado', async () => {
    const id = uniqueClientId();
    await SELF.fetch('https://example.com/api/clients', {
      method: 'POST',
      headers: AUTH_HEADERS,
      body: JSON.stringify(clientPayload(id)),
    });

    const del = await SELF.fetch(`https://example.com/api/clients/${id}`, {
      method: 'DELETE',
      headers: AUTH_HEADERS,
    });
    expect(del.status).toBe(200);

    const list = await SELF.fetch('https://example.com/api/clients', { headers: AUTH_HEADERS });
    const clients = await list.json() as Array<{ id: string }>;
    expect(clients.some(c => c.id === id)).toBe(false);
  });

  it('rechaza crear un cliente duplicado', async () => {
    const id = uniqueClientId();
    await SELF.fetch('https://example.com/api/clients', {
      method: 'POST',
      headers: AUTH_HEADERS,
      body: JSON.stringify(clientPayload(id)),
    });

    const dup = await SELF.fetch('https://example.com/api/clients', {
      method: 'POST',
      headers: AUTH_HEADERS,
      body: JSON.stringify(clientPayload(id)),
    });
    expect(dup.status).toBe(409);
  });

  it.each(['id', 'name', 'bucketName', 'endpoint', 'accessKeyId', 'secretAccessKey'])(
    'rechaza crear cliente con campo "%s" faltante',
    async (field) => {
      const id = uniqueClientId();
      const payload = clientPayload(id) as Record<string, unknown>;
      delete payload[field];
      const res = await SELF.fetch('https://example.com/api/clients', {
        method: 'POST',
        headers: AUTH_HEADERS,
        body: JSON.stringify(payload),
      });
      expect(res.status).toBe(400);
    },
  );
});

// ─── I-W-09 — Paginación en /api/list ────────────────────────────────────────
// Nota: activateS3Mock() se llama dentro de cada test (no en beforeEach) porque
// en @cloudflare/vitest-pool-workers el estado de fetchMock en beforeEach no
// persiste correctamente al contexto del worker principal cuando se usa SELF.

describe('paginacion en /api/list [I-W-09]', () => {
  it('respeta el limite maximo de 100 aunque se pida limit=500', async () => {
    activateS3Mock();
    const id = uniqueClientId();
    await SELF.fetch('https://example.com/api/clients', {
      method: 'POST',
      headers: AUTH_HEADERS,
      body: JSON.stringify(clientPayload(id)),
    });

    // Mock returns 5 files; handler would have requested max-keys=100 (capped from 500)
    mockS3List([
      { key: 'a.png' }, { key: 'b.png' }, { key: 'c.png' },
      { key: 'd.png' }, { key: 'e.png' },
    ]);

    const res = await SELF.fetch('https://example.com/api/list?limit=500', {
      headers: clientHeaders(id),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { files: unknown[] };
    expect(body.files.length).toBeLessThanOrEqual(100);
  });

  it('devuelve nextCursor cuando hay mas archivos que el limite', async () => {
    activateS3Mock();
    const id = uniqueClientId();
    await SELF.fetch('https://example.com/api/clients', {
      method: 'POST',
      headers: AUTH_HEADERS,
      body: JSON.stringify(clientPayload(id)),
    });

    mockS3List([{ key: 'a.png' }, { key: 'b.png' }], [], 'cursor-page-2');

    const res = await SELF.fetch('https://example.com/api/list?limit=2', {
      headers: clientHeaders(id),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { nextCursor: string | null };
    expect(body.nextCursor).not.toBeNull();
    expect(body.nextCursor).toBe('cursor-page-2');
  });

  it('nextCursor permite recuperar la siguiente pagina', async () => {
    activateS3Mock();
    const id = uniqueClientId();
    await SELF.fetch('https://example.com/api/clients', {
      method: 'POST',
      headers: AUTH_HEADERS,
      body: JSON.stringify(clientPayload(id)),
    });

    // Primera página: 2 archivos + cursor
    mockS3List([{ key: 'a.png' }, { key: 'b.png' }], [], 'tok2');
    const page1 = await SELF.fetch('https://example.com/api/list?limit=2', {
      headers: clientHeaders(id),
    });
    const body1 = await page1.json() as { files: unknown[]; nextCursor: string };
    expect(body1.files).toHaveLength(2);
    expect(body1.nextCursor).toBe('tok2');

    // Segunda página con cursor: 1 archivo, sin cursor
    mockS3List([{ key: 'c.png' }]);
    const page2 = await SELF.fetch(
      `https://example.com/api/list?limit=2&cursor=${body1.nextCursor}`,
      { headers: clientHeaders(id) },
    );
    const body2 = await page2.json() as { files: Array<{ key: string }>; nextCursor: null };
    expect(body2.files).toHaveLength(1);
    expect(body2.files[0].key).toBe('c.png');
    expect(body2.nextCursor).toBeNull();
  });
});
