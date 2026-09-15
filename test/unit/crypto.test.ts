/**
 * Reutilización de IV en AES-GCM con la misma clave es una vulnerabilidad
 * criptográfica crítica (catastrophic failure of confidentiality).
 */
import { describe, expect, it } from 'vitest';
import { encryptCredentials, decryptCredentials } from '../../src/crypto';
import { generateTestMasterKey } from '../helpers/crypto-fixtures';
import type { EncryptedBlob } from '../../src/types';

// ─── Helpers locales ──────────────────────────────────────────────────────────

function flipFirstByte(b64: string): string {
  const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  bytes[0] ^= 0xff;
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function flipLastByte(b64: string): string {
  const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  bytes[bytes.length - 1] ^= 0xff;
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

// ─── U-W-01 — Roundtrip ───────────────────────────────────────────────────────

describe('encryptCredentials/decryptCredentials — roundtrip [U-W-01]', () => {
  it('descifra exactamente lo que se cifró — credenciales típicas ASCII', async () => {
    const masterKey = await generateTestMasterKey();
    const creds = { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' };
    const blob = await encryptCredentials(creds, masterKey);
    const result = await decryptCredentials(blob, masterKey);
    expect(result).toEqual(creds);
  });

  it('maneja credenciales con secreto vacío', async () => {
    const masterKey = await generateTestMasterKey();
    const creds = { accessKeyId: 'test-key', secretAccessKey: '' };
    const blob = await encryptCredentials(creds, masterKey);
    const result = await decryptCredentials(blob, masterKey);
    expect(result).toEqual(creds);
  });

  it('preserva credenciales con caracteres Unicode y emoji en los valores', async () => {
    const masterKey = await generateTestMasterKey();
    const creds = { accessKeyId: 'ñ-αβγ-key', secretAccessKey: '🦤-Ñandú-secret' };
    const blob = await encryptCredentials(creds, masterKey);
    const result = await decryptCredentials(blob, masterKey);
    expect(result).toEqual(creds);
  });

  it('preserva JSON serializado de credenciales — caso de uso real del worker', async () => {
    const masterKey = await generateTestMasterKey();
    const creds = { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'abc123/+secretKey==' };
    const blob = await encryptCredentials(creds, masterKey);
    const result = await decryptCredentials(blob, masterKey);
    expect(result).toEqual(creds);
  });

  it('maneja secretos largos (~5KB) sin corrupción', async () => {
    const masterKey = await generateTestMasterKey();
    const creds = { accessKeyId: 'a'.repeat(100), secretAccessKey: 'b'.repeat(5000) };
    const blob = await encryptCredentials(creds, masterKey);
    const result = await decryptCredentials(blob, masterKey);
    expect(result).toEqual(creds);
  });
});

// ─── U-W-02 — Unicidad de IV ──────────────────────────────────────────────────

describe('encryptCredentials — IV uniqueness [U-W-02]', () => {
  it('genera IVs distintos para cifrados consecutivos del mismo plaintext', async () => {
    const masterKey = await generateTestMasterKey();
    const creds = { accessKeyId: 'AKIA123', secretAccessKey: 'secret456' };
    const ivs = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const blob = await encryptCredentials(creds, masterKey);
      ivs.add(blob.iv);
    }
    expect(ivs.size).toBe(100);
  });

  it('genera ciphertexts distintos para cifrados consecutivos del mismo plaintext', async () => {
    const masterKey = await generateTestMasterKey();
    const creds = { accessKeyId: 'AKIA123', secretAccessKey: 'secret456' };
    const ciphertexts = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const blob = await encryptCredentials(creds, masterKey);
      ciphertexts.add(blob.data);
    }
    expect(ciphertexts.size).toBe(100);
  });

  it('no reutiliza IVs entre distintas masterKeys', async () => {
    const creds = { accessKeyId: 'AKIA123', secretAccessKey: 'secret456' };
    const ivs = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const masterKey = await generateTestMasterKey();
      const blob = await encryptCredentials(creds, masterKey);
      ivs.add(blob.iv);
    }
    expect(ivs.size).toBe(50);
  });
});

// ─── U-W-03 — Rutas de error en decryptCredentials ───────────────────────────

describe('decryptCredentials — error paths [U-W-03]', () => {
  it('lanza error con masterKey incorrecta', async () => {
    const keyA = await generateTestMasterKey();
    const keyB = await generateTestMasterKey();
    const blob = await encryptCredentials({ accessKeyId: 'id', secretAccessKey: 'secret' }, keyA);
    await expect(decryptCredentials(blob, keyB)).rejects.toThrow();
  });

  it('lanza error con IV manipulado', async () => {
    const masterKey = await generateTestMasterKey();
    const blob = await encryptCredentials({ accessKeyId: 'id', secretAccessKey: 'secret' }, masterKey);
    const tampered: EncryptedBlob = { iv: flipFirstByte(blob.iv), data: blob.data };
    await expect(decryptCredentials(tampered, masterKey)).rejects.toThrow();
  });

  it('lanza error con ciphertext manipulado (tampering)', async () => {
    const masterKey = await generateTestMasterKey();
    const blob = await encryptCredentials({ accessKeyId: 'id', secretAccessKey: 'secret' }, masterKey);
    const tampered: EncryptedBlob = { iv: blob.iv, data: flipLastByte(blob.data) };
    await expect(decryptCredentials(tampered, masterKey)).rejects.toThrow();
  });

  it('lanza error con blob truncado (IV y data vacíos)', async () => {
    const masterKey = await generateTestMasterKey();
    const truncated: EncryptedBlob = { iv: '', data: '' };
    await expect(decryptCredentials(truncated, masterKey)).rejects.toThrow();
  });

  it('lanza error con blob sin campo iv', async () => {
    const masterKey = await generateTestMasterKey();
    const invalid = { data: btoa('somedataXXXXXXXX') } as unknown as EncryptedBlob;
    await expect(decryptCredentials(invalid, masterKey)).rejects.toThrow();
  });
});
