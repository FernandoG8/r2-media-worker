import { describe, expect, it } from 'vitest';
import {
  sanitizeEndpoint,
  isAllowedMimeType,
  isFileSizeAllowed,
  MAX_FILE_SIZE_BYTES,
  isAllowedCacheControl,
  resolveMaxAge,
} from '../../src/validators';

// ─── U-W-07 — sanitizeEndpoint ────────────────────────────────────────────────

describe('sanitizeEndpoint [U-W-07]', () => {
  it('no modifica un endpoint ya limpio', () => {
    expect(sanitizeEndpoint('https://abc.r2.cloudflarestorage.com', 'mybucket'))
      .toBe('https://abc.r2.cloudflarestorage.com');
  });

  it('elimina trailing slash único', () => {
    expect(sanitizeEndpoint('https://abc.r2.cloudflarestorage.com/', 'mybucket'))
      .toBe('https://abc.r2.cloudflarestorage.com');
  });

  it('elimina múltiples trailing slashes', () => {
    expect(sanitizeEndpoint('https://abc.r2.cloudflarestorage.com///', 'mybucket'))
      .toBe('https://abc.r2.cloudflarestorage.com');
  });

  it('elimina el sufijo /bucketName cuando está al final', () => {
    expect(sanitizeEndpoint('https://abc.r2.cloudflarestorage.com/mybucket', 'mybucket'))
      .toBe('https://abc.r2.cloudflarestorage.com');
  });

  it('elimina trailing slash Y sufijo /bucketName combinados', () => {
    expect(sanitizeEndpoint('https://abc.r2.cloudflarestorage.com/mybucket/', 'mybucket'))
      .toBe('https://abc.r2.cloudflarestorage.com');
  });

  it('no elimina el bucketName si aparece en el subdominio (no como sufijo de path)', () => {
    expect(sanitizeEndpoint('https://mybucket.r2.cloudflarestorage.com', 'mybucket'))
      .toBe('https://mybucket.r2.cloudflarestorage.com');
  });

  it('maneja cadena vacía', () => {
    expect(sanitizeEndpoint('', 'bucket')).toBe('');
  });

  it('elimina espacios del inicio y fin (trim)', () => {
    expect(sanitizeEndpoint('  https://abc.r2.cloudflarestorage.com  ', 'mybucket'))
      .toBe('https://abc.r2.cloudflarestorage.com');
  });
});

// ─── U-W-08 — isAllowedMimeType ──────────────────────────────────────────────

describe('isAllowedMimeType [U-W-08]', () => {
  it('acepta image/jpeg', () => {
    expect(isAllowedMimeType('image/jpeg')).toBe(true);
  });

  it('acepta image/png', () => {
    expect(isAllowedMimeType('image/png')).toBe(true);
  });

  it('acepta image/webp', () => {
    expect(isAllowedMimeType('image/webp')).toBe(true);
  });

  it('acepta image/gif', () => {
    expect(isAllowedMimeType('image/gif')).toBe(true);
  });

  it('acepta image/svg+xml', () => {
    expect(isAllowedMimeType('image/svg+xml')).toBe(true);
  });

  it('acepta image/avif', () => {
    expect(isAllowedMimeType('image/avif')).toBe(true);
  });

  it('rechaza application/pdf', () => {
    expect(isAllowedMimeType('application/pdf')).toBe(false);
  });

  it('rechaza image/tiff (imagen pero no en la allowlist)', () => {
    expect(isAllowedMimeType('image/tiff')).toBe(false);
  });

  it('rechaza cadena vacía', () => {
    expect(isAllowedMimeType('')).toBe(false);
  });

  it('rechaza image/ sin subtipo', () => {
    expect(isAllowedMimeType('image/')).toBe(false);
  });

  it('rechaza application/octet-stream', () => {
    expect(isAllowedMimeType('application/octet-stream')).toBe(false);
  });
});

// ─── U-W-09 — isFileSizeAllowed ──────────────────────────────────────────────

describe('isFileSizeAllowed [U-W-09]', () => {
  it('acepta 0 bytes (archivo vacío)', () => {
    // Un archivo de 0 bytes pasa la validación de tamaño.
    // La validación de contenido no existe en el worker.
    expect(isFileSizeAllowed(0)).toBe(true);
  });

  it('acepta 1 byte', () => {
    expect(isFileSizeAllowed(1)).toBe(true);
  });

  it('acepta MAX_FILE_SIZE_BYTES - 1 (justo por debajo del límite)', () => {
    expect(isFileSizeAllowed(MAX_FILE_SIZE_BYTES - 1)).toBe(true);
  });

  it('acepta exactamente MAX_FILE_SIZE_BYTES (en el límite)', () => {
    expect(isFileSizeAllowed(MAX_FILE_SIZE_BYTES)).toBe(true);
  });

  it('rechaza MAX_FILE_SIZE_BYTES + 1 (un byte sobre el límite)', () => {
    expect(isFileSizeAllowed(MAX_FILE_SIZE_BYTES + 1)).toBe(false);
  });

  it('rechaza 100 MB', () => {
    expect(isFileSizeAllowed(100 * 1024 * 1024)).toBe(false);
  });

  it('acepta números negativos — hallazgo: la validación no rechaza tamaños imposibles', () => {
    // -1 <= MAX_FILE_SIZE_BYTES es true. El validador no contempla valores
    // negativos porque file.size en la Web API nunca es negativo; aun así
    // el contrato de la función no lo protege explícitamente.
    expect(isFileSizeAllowed(-1)).toBe(true);
  });
});

// ─── U-W-10 — isAllowedCacheControl ──────────────────────────────────────────

describe('isAllowedCacheControl [U-W-10]', () => {
  it('acepta public, max-age=31536000, immutable', () => {
    expect(isAllowedCacheControl('public, max-age=31536000, immutable')).toBe(true);
  });

  it('acepta public, max-age=15768000, immutable', () => {
    expect(isAllowedCacheControl('public, max-age=15768000, immutable')).toBe(true);
  });

  it('acepta public, max-age=2592000, immutable', () => {
    expect(isAllowedCacheControl('public, max-age=2592000, immutable')).toBe(true);
  });

  it('rechaza valor arbitrario no en la lista', () => {
    expect(isAllowedCacheControl('no-store')).toBe(false);
  });

  it('rechaza cadena vacía', () => {
    expect(isAllowedCacheControl('')).toBe(false);
  });

  it('rechaza null (comportamiento real: Set.has(null) retorna false)', () => {
    // null no es un string válido; al castear, Set.has(null) retorna false.
    // En router.ts el guard rawCacheControl && ... ya filtra null antes de llamar
    // a esta función, por lo que este caso solo ocurre en llamadas directas.
    expect(isAllowedCacheControl(null as unknown as string)).toBe(false);
  });

  it('es case-sensitive: mayúsculas en Public → rechazado', () => {
    expect(isAllowedCacheControl('Public, max-age=31536000, immutable')).toBe(false);
  });
});

// ─── U-W-11 — resolveMaxAge ───────────────────────────────────────────────────

describe('resolveMaxAge [U-W-11]', () => {
  it('retorna 31536000 cuando se pide 31536000', () => {
    expect(resolveMaxAge(31536000)).toBe(31536000);
  });

  it('retorna 15768000 cuando se pide 15768000', () => {
    expect(resolveMaxAge(15768000)).toBe(15768000);
  });

  it('retorna 2592000 cuando se pide 2592000', () => {
    expect(resolveMaxAge(2592000)).toBe(2592000);
  });

  it('retorna el default 31536000 para un número no en la lista', () => {
    expect(resolveMaxAge(999)).toBe(31536000);
  });

  it('retorna el default 31536000 para undefined', () => {
    expect(resolveMaxAge(undefined)).toBe(31536000);
  });

  it('retorna el default para 0', () => {
    expect(resolveMaxAge(0)).toBe(31536000);
  });

  it('retorna el default para un número negativo', () => {
    expect(resolveMaxAge(-1)).toBe(31536000);
  });
});
