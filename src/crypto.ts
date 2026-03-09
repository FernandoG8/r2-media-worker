import type { ClientCredentials, EncryptedBlob } from './types';

function base64ToBuffer(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function bufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

async function importKey(masterKeyB64: string): Promise<CryptoKey> {
  const raw = base64ToBuffer(masterKeyB64);
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encryptCredentials(
  creds: ClientCredentials,
  masterKeyB64: string,
): Promise<EncryptedBlob> {
  const key = await importKey(masterKeyB64);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(JSON.stringify(creds));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);
  return {
    iv: bufferToBase64(iv.buffer),
    data: bufferToBase64(encrypted),
  };
}

export async function decryptCredentials(
  blob: EncryptedBlob,
  masterKeyB64: string,
): Promise<ClientCredentials> {
  const key = await importKey(masterKeyB64);
  const iv = new Uint8Array(base64ToBuffer(blob.iv));
  const data = base64ToBuffer(blob.data);
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
  return JSON.parse(new TextDecoder().decode(decrypted));
}
