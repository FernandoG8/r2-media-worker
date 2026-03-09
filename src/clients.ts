import type { ClientConfig, ClientCredentials, EncryptedBlob } from './types';
import { encryptCredentials, decryptCredentials } from './crypto';

export async function listClients(kv: KVNamespace): Promise<{ id: string; config: ClientConfig }[]> {
  const indexRaw = await kv.get('clients:index');
  const ids: string[] = indexRaw ? JSON.parse(indexRaw) : [];

  const results: { id: string; config: ClientConfig }[] = [];
  for (const id of ids) {
    const raw = await kv.get(`client:${id}`);
    if (raw) results.push({ id, config: JSON.parse(raw) });
  }
  return results;
}

export async function getClient(kv: KVNamespace, id: string): Promise<ClientConfig | null> {
  const raw = await kv.get(`client:${id}`);
  return raw ? JSON.parse(raw) : null;
}

export async function getClientCredentials(
  kv: KVNamespace,
  id: string,
  masterKey: string,
): Promise<ClientCredentials | null> {
  const raw = await kv.get(`creds:${id}`);
  if (!raw) return null;
  const blob: EncryptedBlob = JSON.parse(raw);
  return decryptCredentials(blob, masterKey);
}

export async function createClient(
  kv: KVNamespace,
  id: string,
  config: ClientConfig,
  creds: ClientCredentials,
  masterKey: string,
): Promise<void> {
  // Encrypt credentials
  const encrypted = await encryptCredentials(creds, masterKey);

  // Write config and encrypted creds
  await kv.put(`client:${id}`, JSON.stringify(config));
  await kv.put(`creds:${id}`, JSON.stringify(encrypted));

  // Update index
  const indexRaw = await kv.get('clients:index');
  const ids: string[] = indexRaw ? JSON.parse(indexRaw) : [];
  if (!ids.includes(id)) {
    ids.push(id);
    await kv.put('clients:index', JSON.stringify(ids));
  }
}

export async function deleteClient(kv: KVNamespace, id: string): Promise<void> {
  await kv.delete(`client:${id}`);
  await kv.delete(`creds:${id}`);

  // Clean index
  const indexRaw = await kv.get('clients:index');
  const ids: string[] = indexRaw ? JSON.parse(indexRaw) : [];
  const filtered = ids.filter(i => i !== id);
  await kv.put('clients:index', JSON.stringify(filtered));
}
