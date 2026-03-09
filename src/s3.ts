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
  ): Promise<void> {
    const encodedKey = key.split('/').map(encodeURIComponent).join('/');
    const res = await aws.fetch(`${endpoint}/${bucket}/${encodedKey}`, {
      method: 'PUT',
      headers: { 'Content-Type': contentType },
      body,
    });
    if (!res.ok) throw new Error(`S3 PutObject failed: ${res.status}`);
  }

  async function s3Delete(bucket: string, key: string): Promise<void> {
    const encodedKey = key.split('/').map(encodeURIComponent).join('/');
    const res = await aws.fetch(`${endpoint}/${bucket}/${encodedKey}`, {
      method: 'DELETE',
    });
    if (!res.ok && res.status !== 204) throw new Error(`S3 DeleteObject failed: ${res.status}`);
  }

  return { s3List, s3Get, s3Put, s3Delete };
}
