/**
 * Validadores de reglas de negocio extraídos de router.ts.
 * Cada función es pura (sin efectos secundarios, sin dependencias externas).
 * Documentados con referencias a INFORME_PRUEBAS.md §2.2 (U-W-07 a U-W-11).
 */

const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/svg+xml',
  'image/avif',
]);

const ALLOWED_CACHE_VALUES = new Set([
  'public, max-age=31536000, immutable',
  'public, max-age=15768000, immutable',
  'public, max-age=2592000, immutable',
]);

/** U-W-11 */
export const ALLOWED_MAX_AGES = [31536000, 15768000, 2592000] as const;
const ALLOWED_MAX_AGES_SET = new Set<number>(ALLOWED_MAX_AGES);

/** U-W-09 */
export const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;

/** U-W-08 */
export function isAllowedMimeType(mimeType: string): boolean {
  return ALLOWED_MIME_TYPES.has(mimeType);
}

/** U-W-09 */
export function isFileSizeAllowed(sizeBytes: number): boolean {
  return sizeBytes <= MAX_FILE_SIZE_BYTES;
}

/** U-W-10 */
export function isAllowedCacheControl(value: string): boolean {
  return ALLOWED_CACHE_VALUES.has(value);
}

/** U-W-11 */
export function resolveMaxAge(requested: number | undefined): number {
  return typeof requested === 'number' && ALLOWED_MAX_AGES_SET.has(requested)
    ? requested
    : 31536000;
}

/** U-W-07 */
export function sanitizeEndpoint(endpoint: string, bucketName: string): string {
  return endpoint
    .trim()
    .replace(/\/+$/, '')
    .replace(new RegExp(`/${bucketName}$`), '');
}
