import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { Env } from '../../src/types';
import { AUTH_HEADERS, clientPayload, uniqueClientId } from '../helpers/factories';

const workerEnv = env as unknown as Env;

async function createClient() {
  const id = uniqueClientId('priv-delete');
  const res = await SELF.fetch('https://example.com/api/clients', {
    method: 'POST',
    headers: AUTH_HEADERS,
    body: JSON.stringify(clientPayload(id)),
  });
  expect(res.status).toBe(201);
  return id;
}

async function deleteClient(id: string) {
  const res = await SELF.fetch(`https://example.com/api/clients/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: AUTH_HEADERS,
  });
  expect(res.status).toBe(200);
}

describe('eliminación completa de datos [P-W-07..08]', () => {
  it('DELETE /api/clients/:id elimina tanto client:{id} como creds:{id} de KV', async () => {
    const id = await createClient();

    expect(await workerEnv.CLIENTS_KV.get(`client:${id}`)).not.toBeNull();
    expect(await workerEnv.CLIENTS_KV.get(`creds:${id}`)).not.toBeNull();

    await deleteClient(id);

    expect(await workerEnv.CLIENTS_KV.get(`client:${id}`)).toBeNull();
    expect(await workerEnv.CLIENTS_KV.get(`creds:${id}`)).toBeNull();
  });

  it('el índice clients:index no contiene el id tras el delete', async () => {
    const id = await createClient();

    await deleteClient(id);

    const rawIndex = await workerEnv.CLIENTS_KV.get('clients:index');
    const index = rawIndex ? JSON.parse(rawIndex) as string[] : [];

    expect(Array.isArray(index)).toBe(true);
    expect(index).not.toContain(id);
  });
});
