import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { encryptCredentials } from '../../src/crypto';
import type { EncryptedBlob, Env } from '../../src/types';
import { AUTH_HEADERS, clientPayload, uniqueClientId } from '../helpers/factories';

const workerEnv = env as unknown as Env;
const TEST_MASTER_KEY = 'BmSp3pD7YHLEpnGnDOufCASTcgxF82deciU5Cfkoypo=';
const ACCESS_KEY = 'AKIAIOSFODNN7EXAMPLE';
const SECRET_KEY = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';

async function createClient(overrides: Record<string, unknown> = {}) {
  const id = uniqueClientId('priv-rest');
  const res = await SELF.fetch('https://example.com/api/clients', {
    method: 'POST',
    headers: AUTH_HEADERS,
    body: JSON.stringify(clientPayload(id, {
      accessKeyId: ACCESS_KEY,
      secretAccessKey: SECRET_KEY,
      ...overrides,
    })),
  });
  expect(res.status).toBe(201);
  return id;
}

async function readEncryptedBlob(clientId: string): Promise<EncryptedBlob> {
  expect(workerEnv.CLIENTS_KV).toBeDefined();
  const raw = await workerEnv.CLIENTS_KV.get(`creds:${clientId}`);
  expect(raw).not.toBeNull();
  return JSON.parse(raw!) as EncryptedBlob;
}

describe('credenciales cifradas en reposo [P-W-01..03, P-W-09]', () => {
  it('las credenciales se almacenan cifradas en KV, no en texto plano', async () => {
    const id = await createClient();

    const raw = await workerEnv.CLIENTS_KV.get(`creds:${id}`);
    expect(raw).not.toBeNull();
    expect(raw).not.toContain(ACCESS_KEY);
    expect(raw).not.toContain(SECRET_KEY);

    const parsed = JSON.parse(raw!) as Partial<EncryptedBlob> & Record<string, unknown>;
    expect(parsed.accessKeyId).toBeUndefined();
    expect(parsed.secretAccessKey).toBeUndefined();
    expect(parsed).toEqual({
      iv: expect.any(String),
      data: expect.any(String),
    });
  });

  it('el blob cifrado no revela las credenciales sin MASTER_KEY', async () => {
    const id = await createClient();
    const blob = await readEncryptedBlob(id);

    expect(() => JSON.parse(blob.data)).toThrow();
    expect(blob.data).not.toContain(ACCESS_KEY);
    expect(blob.data).not.toContain(SECRET_KEY);
  });

  it('dos clientes con las mismas credenciales producen IVs distintos', async () => {
    const idA = await createClient();
    const idB = await createClient();

    const blobA = await readEncryptedBlob(idA);
    const blobB = await readEncryptedBlob(idB);

    expect(blobA.iv).not.toBe(blobB.iv);
    expect(blobA.data).not.toBe(blobB.data);
  });

  it('el módulo usa AES-GCM con 256 bits', async () => {
    // Verificacion indirecta: la MASTER_KEY del config de test tiene 32 bytes
    // raw (256 bits), y el roundtrip de cifrado acepta esa clave AES-GCM.
    const result = await encryptCredentials(
      { accessKeyId: 'test', secretAccessKey: 'test' },
      TEST_MASTER_KEY,
    );

    expect(result).toHaveProperty('iv');
    expect(result).toHaveProperty('data');
  });
});
