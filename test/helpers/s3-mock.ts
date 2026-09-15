import { http, HttpResponse } from 'msw';
import { network } from '../network';

// Debe coincidir con el endpoint en clientPayload().
const S3_ORIGIN = 'https://test-account.r2.cloudflarestorage.com';

/**
 * Activa fetchMock y deshabilita conexiones reales de red para que los
 * interceptores funcionen con las llamadas del worker principal (SELF).
 * Llamar en beforeEach de cada archivo que intercepte S3.
 */
export function activateS3Mock() {
  // Outbound mocks are enabled globally by test/setup.ts.
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
  let remaining = times;
  network.use(http.put(`${S3_ORIGIN}/*`, () => {
    if (remaining-- > 0) return new HttpResponse(null, { status: 200 });
    return new HttpResponse(null, { status: 500 });
  }));
}

/** Intercepta la próxima llamada LIST (GET con ?list-type) al origen S3. */
export function mockS3List(
  files: Array<{ key: string; size?: number }> = [],
  folders: string[] = [],
  nextToken?: string,
) {
  network.use(http.get(`${S3_ORIGIN}/*`, ({ request }) => {
    if (new URL(request.url).searchParams.get('list-type') !== '2') return;
    return new HttpResponse(s3Xml(files, folders, nextToken), {
      status: 200,
      headers: { 'content-type': 'application/xml' },
    });
  }));
}

/**
 * Intercepta la próxima llamada GET de objeto (path /bucket/key sin query).
 * Devuelve 4 bytes de PNG magic number con content-type image/png.
 */
export function mockS3GetObject(contentType = 'image/png') {
  network.use(http.get(`${S3_ORIGIN}/*`, ({ request }) => {
    if (new URL(request.url).search) return;
    return new HttpResponse(new Uint8Array([137, 80, 78, 71]), {
      status: 200,
      headers: { 'content-type': contentType },
    });
  }));
}

/** Intercepta la próxima llamada DELETE al origen S3. */
export function mockS3Delete(times = 1) {
  let remaining = times;
  network.use(http.delete(`${S3_ORIGIN}/*`, () => {
    if (remaining-- > 0) return new HttpResponse(null, { status: 204 });
    return new HttpResponse(null, { status: 500 });
  }));
}
