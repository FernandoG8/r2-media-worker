/**
 * Genera una clave AES-256 válida en base64 usando Web Crypto.
 * Usa la misma codificación que importKey() en src/crypto.ts.
 */
export async function generateTestMasterKey(): Promise<string> {
  const key = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt'],
  );
  const raw = await crypto.subtle.exportKey('raw', key);
  const bytes = new Uint8Array(raw);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}
