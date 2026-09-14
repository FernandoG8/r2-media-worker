import { AwsClient } from 'aws4fetch';
import type { ClientCredentials } from './types';

interface S3Object {
  key: string;
  size: number;
  lastModified: string;
}

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

  return { s3List, s3Get, s3Put, s3Delete, s3Copy, s3Head, s3Presign, s3PutBucketCors, s3UpdateMetadata };
}
