import { fetchMock } from 'cloudflare:test';

// Debe coincidir con el endpoint en clientPayload().
const S3_ORIGIN = 'https://test-account.r2.cloudflarestorage.com';

/**
 * Activa fetchMock y deshabilita conexiones reales de red para que los
 * interceptores funcionen con las llamadas del worker principal (SELF).
 * Llamar en beforeEach de cada archivo que intercepte S3.
 */
export function activateS3Mock() {
  fetchMock.activate();
  fetchMock.disableNetConnect();
}

/** Construye XML de respuesta S3 ListObjectsV2. */
export function s3Xml(
  files: Array<{ key: string; size?: number }> = [],
  folders: string[] = [],
  nextToken?: string,
): string {
  const contents = files
    .map(
      f =>
        `<Contents><Key>${f.key}</Key><Size>${f.size ?? 100}</Size>` +
        `<LastModified>2024-01-01T00:00:00.000Z</LastModified></Contents>`,
    )
    .join('');
  const prefixes = folders
    .map(p => `<CommonPrefixes><Prefix>${p}</Prefix></CommonPrefixes>`)
    .join('');
  const isTruncated = !!nextToken;
  const tokenEl = nextToken ? `<NextContinuationToken>${nextToken}</NextContinuationToken>` : '';
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<ListBucketResult>` +
    `<IsTruncated>${isTruncated}</IsTruncated>${tokenEl}${contents}${prefixes}` +
    `</ListBucketResult>`
  );
}

/**
 * Intercepta la próxima llamada PUT al origen S3.
 * Cubre tanto uploads como copies (s3Copy también usa PUT).
 */
export function mockS3Put(times = 1) {
  fetchMock
    .get(S3_ORIGIN)
    .intercept({ path: /.*/, method: 'PUT' })
    .reply(200, '')
    .times(times);
}

/** Intercepta la próxima llamada LIST (GET con ?list-type) al origen S3. */
export function mockS3List(
  files: Array<{ key: string; size?: number }> = [],
  folders: string[] = [],
  nextToken?: string,
) {
  fetchMock
    .get(S3_ORIGIN)
    // URLSearchParams ordena params alfabéticamente, así que list-type no
    // aparece primero en la query string. El regex busca en cualquier posición.
    .intercept({ path: /list-type=2/, method: 'GET' })
    .reply(200, s3Xml(files, folders, nextToken), {
      headers: { 'content-type': 'application/xml' },
    });
}

/**
 * Intercepta la próxima llamada GET de objeto (path /bucket/key sin query).
 * Devuelve 4 bytes de PNG magic number con content-type image/png.
 */
export function mockS3GetObject(contentType = 'image/png') {
  fetchMock
    .get(S3_ORIGIN)
    // path como /bucket/key (no tiene ?) — distingue de list que sí tiene ?list-type
    .intercept({ path: /^\/[^?]+\/[^?]/, method: 'GET' })
    .reply(200, new Uint8Array([137, 80, 78, 71]), {
      headers: { 'content-type': contentType },
    });
}

/** Intercepta la próxima llamada DELETE al origen S3. */
export function mockS3Delete(times = 1) {
  fetchMock
    .get(S3_ORIGIN)
    .intercept({ path: /.*/, method: 'DELETE' })
    .reply(204, '')
    .times(times);
}
