import { AwsClient } from 'aws4fetch';
import type { ClientCredentials } from './types';

interface S3Object {
  key: string;
  size: number;
  lastModified: string;
}

// The trash lifecycle rule is identified by this constant ID so it can be
// found and replaced in-place inside a bucket's existing lifecycle
// configuration without touching any other rule. The prefix MUST stay
// scoped to the trash folder — an empty or wrong prefix would expire every
// object in the bucket.
export const TRASH_PREFIX = '.mediapanel-trash/';
export const TRASH_LIFECYCLE_RULE_ID = 'mediapanel-trash-30d';
export const TRASH_LIFECYCLE_EXPIRATION_DAYS = 30;

interface S3ListResult {
  folders: string[];
  objects: S3Object[];
  nextContinuationToken: string | null;
  isTruncated: boolean;
}

function parseXmlTag(xml: string, tag: string): string | null {
  const open = `<${tag}>`;
  const close = `</${tag}>`;
  const start = xml.indexOf(open);
  if (start === -1) return null;
  const end = xml.indexOf(close, start);
  if (end === -1) return null;
  return xml.slice(start + open.length, end);
}

function parseAllXmlTags(xml: string, tag: string): string[] {
  const results: string[] = [];
  const open = `<${tag}>`;
  const close = `</${tag}>`;
  let pos = 0;
  while (true) {
    const start = xml.indexOf(open, pos);
    if (start === -1) break;
    const end = xml.indexOf(close, start);
    if (end === -1) break;
    results.push(xml.slice(start + open.length, end));
    pos = end + close.length;
  }
  return results;
}

/**
 * Same walk as parseAllXmlTags, but returns each full block including its
 * own opening/closing tags, verbatim from the source string. Used to carry
 * rules we do not understand through untouched, instead of reconstructing
 * them field by field.
 */
function parseAllXmlBlocks(xml: string, tag: string): string[] {
  const results: string[] = [];
  const open = `<${tag}>`;
  const close = `</${tag}>`;
  let pos = 0;
  while (true) {
    const start = xml.indexOf(open, pos);
    if (start === -1) break;
    const end = xml.indexOf(close, start);
    if (end === -1) break;
    results.push(xml.slice(start, end + close.length));
    pos = end + close.length;
  }
  return results;
}

/**
 * Extracts every <Rule>...</Rule> block from a lifecycle configuration
 * document verbatim. Refuses (throws) rather than guess if the document
 * contains a rule shape parseAllXmlBlocks cannot round-trip faithfully —
 * for example a <Rule with attributes instead of a plain <Rule> tag. Losing
 * an unrecognized rule silently would mean writing back a mutilated
 * configuration, which is worse than failing the whole operation.
 */
function extractLifecycleRuleBlocksOrThrow(xml: string): string[] {
  const blocks = parseAllXmlBlocks(xml, 'Rule');
  const openTagCount = (xml.match(/<Rule[\s>]/g) ?? []).length;
  if (openTagCount !== blocks.length) {
    throw new Error(
      'S3 lifecycle configuration contains rules this client cannot safely parse; refusing to rewrite it',
    );
  }
  return blocks;
}

export function createS3Client(creds: ClientCredentials, endpoint: string) {
  const aws = new AwsClient({
    accessKeyId: creds.accessKeyId,
    secretAccessKey: creds.secretAccessKey,
    service: 's3',
    region: 'auto',
  });

  async function s3List(
    bucket: string,
    prefix: string,
    delimiter: string,
    maxKeys: number,
    continuationToken?: string,
  ): Promise<S3ListResult> {
    const params = new URLSearchParams({
      'list-type': '2',
      'encoding-type': 'url',
      prefix,
      delimiter,
      'max-keys': String(maxKeys),
    });
    if (continuationToken) params.set('continuation-token', continuationToken);

    const res = await aws.fetch(`${endpoint}/${bucket}?${params}`);
    if (!res.ok) throw new Error(`S3 ListObjectsV2 failed: ${res.status}`);
    const xml = await res.text();

    // Parse common prefixes (folders)
    const folders: string[] = [];
    const cpBlocks = parseAllXmlTags(xml, 'CommonPrefixes');
    for (const block of cpBlocks) {
      const p = parseXmlTag(block, 'Prefix');
      if (p) folders.push(decodeURIComponent(p));
    }

    // Parse objects
    const objects: S3Object[] = [];
    const contentBlocks = parseAllXmlTags(xml, 'Contents');
    for (const block of contentBlocks) {
      const key = parseXmlTag(block, 'Key');
      const size = parseXmlTag(block, 'Size');
      const lastModified = parseXmlTag(block, 'LastModified');
      if (key) {
        objects.push({
          key: decodeURIComponent(key),
          size: size ? parseInt(size) : 0,
          lastModified: lastModified ?? '',
        });
      }
    }

    const isTruncated = parseXmlTag(xml, 'IsTruncated') === 'true';
    const nextContinuationToken = isTruncated
      ? parseXmlTag(xml, 'NextContinuationToken')
      : null;

    return { folders, objects, nextContinuationToken, isTruncated };
  }

  async function s3Get(bucket: string, key: string): Promise<Response> {
    const encodedKey = key.split('/').map(encodeURIComponent).join('/');
    const res = await aws.fetch(`${endpoint}/${bucket}/${encodedKey}`);
    return res;
  }

  async function s3Put(
    bucket: string,
    key: string,
    body: ArrayBuffer | ReadableStream,
    contentType: string,
    extraHeaders?: Record<string, string>,
  ): Promise<void> {
    const encodedKey = key.split('/').map(encodeURIComponent).join('/');
    const res = await aws.fetch(`${endpoint}/${bucket}/${encodedKey}`, {
      method: 'PUT',
      headers: { 'Content-Type': contentType, ...extraHeaders },
      body,
    });
    if (!res.ok) throw new Error(`S3 PutObject failed: ${res.status}`);
  }

  async function s3Copy(bucket: string, sourceKey: string, destKey: string): Promise<void> {
    const encodedDest = destKey.split('/').map(encodeURIComponent).join('/');
    const copySource = `/${bucket}/${sourceKey.split('/').map(encodeURIComponent).join('/')}`;
    const res = await aws.fetch(`${endpoint}/${bucket}/${encodedDest}`, {
      method: 'PUT',
      headers: { 'x-amz-copy-source': copySource },
    });
    if (!res.ok) throw new Error(`S3 CopyObject failed: ${res.status}`);
  }

  async function s3Delete(bucket: string, key: string): Promise<void> {
    const encodedKey = key.split('/').map(encodeURIComponent).join('/');
    const res = await aws.fetch(`${endpoint}/${bucket}/${encodedKey}`, {
      method: 'DELETE',
    });
    if (!res.ok && res.status !== 204) throw new Error(`S3 DeleteObject failed: ${res.status}`);
  }

  /**
   * HEAD request — returns object metadata without downloading content.
   */
  async function s3Head(bucket: string, key: string): Promise<Response> {
    const encodedKey = key.split('/').map(encodeURIComponent).join('/');
    return aws.fetch(`${endpoint}/${bucket}/${encodedKey}`, { method: 'HEAD' });
  }

  async function s3Presign(
    bucket: string,
    key: string,
    method: 'GET' | 'PUT',
    expiresInSeconds = 900,
    headers?: Record<string, string>,
  ): Promise<string> {
    const encodedKey = key.split('/').map(encodeURIComponent).join('/');
    const url = new URL(`${endpoint}/${bucket}/${encodedKey}`);
    url.searchParams.set('X-Amz-Expires', String(expiresInSeconds));
    const signed = await aws.sign(url, {
      method,
      headers,
      aws: { signQuery: true },
    });
    return signed.url;
  }

  function xmlEscape(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /**
   * Configure the bucket's CORS policy (S3 PutBucketCors) so presigned upload/
   * download URLs generated by s3Presign can be used directly from a browser —
   * R2 bucket CORS is separate from and unrelated to the Worker's own CORS
   * headers, and only covers requests that go straight to the R2 endpoint.
   */
  async function s3PutBucketCors(bucket: string, allowedOrigins: string[]): Promise<void> {
    const originTags = allowedOrigins.map(origin => `<AllowedOrigin>${xmlEscape(origin)}</AllowedOrigin>`).join('');
    const body = `<?xml version="1.0" encoding="UTF-8"?>` +
      `<CORSConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">` +
      `<CORSRule>${originTags}` +
      `<AllowedMethod>GET</AllowedMethod><AllowedMethod>PUT</AllowedMethod>` +
      `<AllowedHeader>content-type</AllowedHeader>` +
      `<ExposeHeader>ETag</ExposeHeader>` +
      `<MaxAgeSeconds>3600</MaxAgeSeconds>` +
      `</CORSRule></CORSConfiguration>`;

    const res = await aws.fetch(`${endpoint}/${bucket}?cors`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/xml' },
      body,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`S3 PutBucketCors failed: ${res.status} ${detail.slice(0, 300)}`);
    }
  }

  /**
   * Read the bucket's current lifecycle configuration (S3
   * GetBucketLifecycleConfiguration) and return each of its rules as a raw
   * <Rule>...</Rule> XML block, untouched.
   *
   * A bucket with no lifecycle configuration at all is a normal, expected
   * state — R2 answers that with a 404 whose body carries the
   * NoSuchLifecycleConfiguration error code — and is reported as an empty
   * rule list rather than an error. Any other failure (including a 404 for
   * a different reason) is thrown.
   */
  async function s3GetBucketLifecycleConfiguration(bucket: string): Promise<string[]> {
    const res = await aws.fetch(`${endpoint}/${bucket}?lifecycle`);
    if (res.status === 404) {
      const detail = await res.text().catch(() => '');
      if (detail.includes('<Code>NoSuchLifecycleConfiguration</Code>')) {
        return [];
      }
      throw new Error(`S3 GetBucketLifecycleConfiguration failed: 404 ${detail.slice(0, 300)}`);
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`S3 GetBucketLifecycleConfiguration failed: ${res.status} ${detail.slice(0, 300)}`);
    }
    const xml = await res.text();
    return extractLifecycleRuleBlocksOrThrow(xml);
  }

  /**
   * Write the bucket's lifecycle configuration (S3
   * PutBucketLifecycleConfiguration). This REPLACES the entire
   * configuration — callers must pass every rule that should survive, not
   * just the one they care about.
   */
  async function s3PutBucketLifecycleConfiguration(bucket: string, ruleBlocks: string[]): Promise<void> {
    const body = `<?xml version="1.0" encoding="UTF-8"?>` +
      `<LifecycleConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">` +
      ruleBlocks.join('') +
      `</LifecycleConfiguration>`;

    const res = await aws.fetch(`${endpoint}/${bucket}?lifecycle`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/xml' },
      body,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`S3 PutBucketLifecycleConfiguration failed: ${res.status} ${detail.slice(0, 300)}`);
    }
  }

  function buildTrashLifecycleRuleBlock(): string {
    return `<Rule>` +
      `<ID>${xmlEscape(TRASH_LIFECYCLE_RULE_ID)}</ID>` +
      `<Filter><Prefix>${xmlEscape(TRASH_PREFIX)}</Prefix></Filter>` +
      `<Status>Enabled</Status>` +
      `<Expiration><Days>${TRASH_LIFECYCLE_EXPIRATION_DAYS}</Days></Expiration>` +
      `</Rule>`;
  }

  /**
   * Ensure the bucket expires trash objects after
   * TRASH_LIFECYCLE_EXPIRATION_DAYS days, without disturbing any other
   * lifecycle rule already configured on the bucket (such as R2's default
   * multipart-abort rule, or a client-specific rule we don't know about).
   *
   * Reads the existing configuration, drops only the rule matching our own
   * ID (so re-applying is idempotent instead of accumulating duplicates),
   * keeps every other rule byte-for-byte, appends a freshly built copy of
   * our rule, and writes the merged set back.
   */
  async function s3ApplyTrashLifecycleRule(bucket: string): Promise<void> {
    const existingRuleBlocks = await s3GetBucketLifecycleConfiguration(bucket);
    const otherRuleBlocks = existingRuleBlocks.filter(
      block => parseXmlTag(block, 'ID') !== TRASH_LIFECYCLE_RULE_ID,
    );
    const nextRuleBlocks = [...otherRuleBlocks, buildTrashLifecycleRuleBlock()];
    await s3PutBucketLifecycleConfiguration(bucket, nextRuleBlocks);
  }

  /**
   * Copy an object to itself replacing only the metadata.
   * The file content is NOT transferred — only the metadata headers change.
   * Used to update Cache-Control on existing objects without re-uploading.
   */
  async function s3UpdateMetadata(
    bucket: string,
    key: string,
    metadata: Record<string, string>,
  ): Promise<void> {
    const encodedKey = key.split('/').map(encodeURIComponent).join('/');
    const copySource = `/${bucket}/${encodedKey}`;

    // We need the original Content-Type because REPLACE clears all metadata.
    const headRes = await s3Head(bucket, key);
    const contentType = headRes.headers.get('content-type') ?? 'application/octet-stream';

    const headers: Record<string, string> = {
      'x-amz-copy-source': copySource,
      'x-amz-metadata-directive': 'REPLACE',
      'Content-Type': contentType,
      ...metadata,
    };

    const res = await aws.fetch(`${endpoint}/${bucket}/${encodedKey}`, {
      method: 'PUT',
      headers,
    });
    if (!res.ok) throw new Error(`S3 UpdateMetadata failed: ${res.status}`);
  }

  return {
    s3List,
    s3Get,
    s3Put,
    s3Delete,
    s3Copy,
    s3Head,
    s3Presign,
    s3PutBucketCors,
    s3UpdateMetadata,
    s3GetBucketLifecycleConfiguration,
    s3PutBucketLifecycleConfiguration,
    s3ApplyTrashLifecycleRule,
  };
}
