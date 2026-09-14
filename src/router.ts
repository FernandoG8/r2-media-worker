import type { Env } from './types';
import { ALLOWED_ORIGINS, corsHeaders, json, resolveOrigin } from './cors';
import { verifyAccessJwt } from './access';
import { createS3Client } from './s3';
import { listClients, getClient, getClientCredentials, createClient, deleteClient, updateClientConfig } from './clients';

const TRASH_PREFIX = '.mediapanel-trash/';
const BACKUP_PREFIX = '.mediapanel-backups/';

function isInternalKey(key: string): boolean {
  return key.startsWith(TRASH_PREFIX) || key.startsWith(BACKUP_PREFIX);
}

function normalizeFolderPrefix(prefix: string): string {
  return prefix.endsWith('/') ? prefix : `${prefix}/`;
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseTrashLimit(value: string | null, fallback: number, maximum: number): number | null {
  if (value === null) return fallback;
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= maximum ? parsed : null;
}

function parseTrashCursor(value: string | null): string | undefined | null {
  if (value === null || value === '') return undefined;
  // Cursors are provider-issued opaque values. Only transport size is checked;
  // URLSearchParams has already decoded the query component for us.
  return value.length <= 4096 ? value : null;
}

function isTrashGroupPrefix(prefix: string): boolean {
  return prefix.startsWith(TRASH_PREFIX) &&
    prefix.endsWith('/') &&
    UUID_V4.test(prefix.slice(TRASH_PREFIX.length, -1)) &&
    prefix.slice(TRASH_PREFIX.length, -1).indexOf('/') === -1;
}

// Same UUID shape /api/restore has always validated its token with.
const RESTORE_TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolves a requested key to an absolute R2 key strictly inside `trashRoot`,
 * or null if the key cannot possibly belong to that group. Membership is
 * decided by exact-prefix construction (rejecting `.`/`..`/empty segments and
 * absolute paths before concatenation), never by a substring `includes` check.
 */
function resolveTrashObjectKey(trashRoot: string, rawKey: string): string | null {
  if (!rawKey || rawKey.includes('\\') || rawKey.includes('\0')) return null;
  if (rawKey.startsWith('/')) return null;
  const segments = rawKey.split('/');
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) return null;
  const fullKey = `${trashRoot}${rawKey}`;
  if (!fullKey.startsWith(trashRoot) || fullKey.length <= trashRoot.length) return null;
  return fullKey;
}

async function listAllObjects(
  s3List: ReturnType<typeof createS3Client>['s3List'],
  bucket: string,
  prefix: string,
) {
  const objects: Array<{ key: string; size: number; lastModified: string }> = [];
  let cursor: string | undefined;
  do {
    const result = await s3List(bucket, prefix, '', 1000, cursor);
    objects.push(...result.objects);
    cursor = result.nextContinuationToken ?? undefined;
  } while (cursor);
  return objects;
}

function createTrashRoot(): string {
  return `${TRASH_PREFIX}${crypto.randomUUID()}/`;
}

async function isAuthorized(request: Request, env: Env): Promise<boolean> {
  // Temporary defense in depth while the panel still sends X-API-Key. Hashing
  // both values avoids leaking its length before Workers' timing-safe compare.
  const provided = request.headers.get('X-API-Key') ?? '';
  const expected = env.API_SECRET ?? '';
  const encoder = new TextEncoder();
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(provided)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ]);
  return Boolean(expected) && crypto.subtle.timingSafeEqual(providedHash, expectedHash);
}

/**
 * Returns a key that does not collide with existing R2 objects.
 * If `candidate` exists, tries `stem (1).ext`, `stem (2).ext`, … up to 99.
 * `excludeKeys` — keys that should be treated as free (e.g. the source files
 *   being moved this request, which will be deleted after copy).
 * `usedInBatch` — keys already claimed in the same batch (not yet written to R2).
 */
async function resolveUniqueKey(
  s3Head: (bucket: string, key: string) => Promise<Response>,
  bucket: string,
  candidate: string,
  excludeKeys: Set<string>,
  usedInBatch: Set<string> = new Set(),
): Promise<string> {
  const isFree = async (key: string) => {
    if (usedInBatch.has(key)) return false;
    if (excludeKeys.has(key)) return true;
    const res = await s3Head(bucket, key);
    return res.status === 404;
  };

  if (await isFree(candidate)) return candidate;

  const lastSlash = candidate.lastIndexOf('/');
  const dir = lastSlash >= 0 ? candidate.slice(0, lastSlash + 1) : '';
  const filename = lastSlash >= 0 ? candidate.slice(lastSlash + 1) : candidate;
  const dotIdx = filename.lastIndexOf('.');
  const stem = dotIdx > 0 ? filename.slice(0, dotIdx) : filename;
  const ext = dotIdx > 0 ? filename.slice(dotIdx) : '';

  for (let i = 1; i < 100; i++) {
    const next = `${dir}${stem} (${i})${ext}`;
    if (await isFree(next)) return next;
  }
  throw new Error(`Cannot find unique key for ${candidate} after 99 attempts`);
}

export async function handleRequest(request: Request, env: Env): Promise<Response> {
  const origin = resolveOrigin(request, env);
  const url = new URL(request.url);
  const method = request.method;

  // Preflight CORS
  if (method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }

  // ── GET /file/:clientId/*key — público, sin auth ──────────────────────────
  if (method === 'GET' && url.pathname.startsWith('/file/')) {
    const pathAfterFile = url.pathname.slice('/file/'.length);
    const slashIdx = pathAfterFile.indexOf('/');

    // Ruta vieja /file/:key sin clientId → 404 con mensaje de migración
    if (slashIdx === -1) {
      return json(
        { error: 'URL format changed. Use /file/:clientId/:key' },
        404,
        origin,
      );
    }

    const clientId = decodeURIComponent(pathAfterFile.slice(0, slashIdx));
    const key = decodeURIComponent(pathAfterFile.slice(slashIdx + 1));

    if (!clientId || !key) {
      return json({ error: 'Missing clientId or key' }, 400, origin);
    }
    if (isInternalKey(key)) return json({ error: 'Not found' }, 404, origin);

    const client = await getClient(env.CLIENTS_KV, clientId);
    if (!client) return json({ error: 'Client not found' }, 404, origin);

    const creds = await getClientCredentials(env.CLIENTS_KV, clientId, env.MASTER_KEY);
    if (!creds) return json({ error: 'Client credentials not found' }, 500, origin);

    const s3 = createS3Client(creds, client.endpoint);
    const res = await s3.s3Get(client.bucketName, key);

    if (!res.ok) return json({ error: 'Not found' }, 404, origin);

    const headers = new Headers(corsHeaders(origin));
    // Preserve object HTTP metadata (content type, cache policy, disposition,
    // encoding, etc.) instead of replacing it with a one-year default.
    for (const header of ['content-type', 'cache-control', 'content-language', 'content-disposition', 'content-encoding', 'expires', 'etag', 'last-modified']) {
      const value = res.headers.get(header);
      if (value) headers.set(header, value);
    }
    // Objects uploaded without a cache policy get a conservative public cache.
    if (!headers.has('cache-control')) headers.set('cache-control', 'public, max-age=3600');

    return new Response(res.body, { headers });
  }

  // All API routes require a Cloudflare Access assertion before any client,
  // credentials, or R2 state is consulted. OPTIONS intentionally returned
  // above: browser preflights do not carry the Access cookie/assertion.
  if (url.pathname.startsWith('/api/')) {
    const access = await verifyAccessJwt(request, env);
    if (!access.ok) return json({ error: access.error }, access.status, origin);
  } else {
    return json({ error: 'Not found' }, 404, origin);
  }

  // ── Client management endpoints (auth required, no X-Client-ID) ───────────

  // GET /api/clients
  if (method === 'GET' && url.pathname === '/api/clients') {
    if (!await isAuthorized(request, env)) return json({ error: 'Unauthorized' }, 401, origin);
    const clients = await listClients(env.CLIENTS_KV);
    return json(clients, 200, origin);
  }

  // POST /api/clients
  if (method === 'POST' && url.pathname === '/api/clients') {
    if (!await isAuthorized(request, env)) return json({ error: 'Unauthorized' }, 401, origin);

    const body = await request.json<{
      id: string;
      name: string;
      bucketName: string;
      endpoint: string;
      r2BaseUrl: string;
      accessKeyId: string;
      secretAccessKey: string;
      env?: 'prod' | 'test';
    }>();

    if (!body.id || !body.name || !body.bucketName || !body.endpoint || !body.accessKeyId || !body.secretAccessKey) {
      return json({ error: 'Missing required fields' }, 400, origin);
    }

    // Sanitize endpoint: remove trailing slash and accidental bucketName suffix
    const endpoint = body.endpoint
      .trim()
      .replace(/\/+$/, '')
      .replace(new RegExp(`/${body.bucketName}$`), '');

    // Check if already exists
    const existing = await getClient(env.CLIENTS_KV, body.id);
    if (existing) return json({ error: 'Client already exists' }, 409, origin);

    await createClient(
      env.CLIENTS_KV,
      body.id,
      {
        name: body.name,
        bucketName: body.bucketName,
        endpoint,
        r2BaseUrl: body.r2BaseUrl ?? '',
        active: true,
        createdAt: new Date().toISOString(),
        env: body.env ?? 'test',
      },
      { accessKeyId: body.accessKeyId, secretAccessKey: body.secretAccessKey },
      env.MASTER_KEY,
    );

    // Best-effort: the presigned backup URLs only work from the browser once
    // the bucket itself allows the panel's origins via CORS. A failure here
    // does not block client creation — /api/clients/:id/cors can retry it.
    let corsWarning: string | undefined;
    try {
      const newClientS3 = createS3Client({ accessKeyId: body.accessKeyId, secretAccessKey: body.secretAccessKey }, endpoint);
      await newClientS3.s3PutBucketCors(body.bucketName, ALLOWED_ORIGINS);
    } catch (e) {
      corsWarning = e instanceof Error ? e.message : 'Could not configure bucket CORS';
      console.error('CORS setup failed for new client', body.id, corsWarning);
    }

    return json({ id: body.id, name: body.name, ...(corsWarning ? { corsWarning } : {}) }, 201, origin);
  }

  // PATCH /api/clients/:id — update mutable fields (env) without re-entering credentials
  if (method === 'PATCH' && url.pathname.startsWith('/api/clients/')) {
    if (!await isAuthorized(request, env)) return json({ error: 'Unauthorized' }, 401, origin);

    const clientId = decodeURIComponent(url.pathname.slice('/api/clients/'.length));
    if (!clientId) return json({ error: 'Missing client ID' }, 400, origin);

    const existing = await getClient(env.CLIENTS_KV, clientId);
    if (!existing) return json({ error: 'Client not found' }, 404, origin);

    const body = await request.json<{ env?: string; name?: string; r2BaseUrl?: string }>();

    const updates: Parameters<typeof updateClientConfig>[2] = {};
    if (body.env === 'prod' || body.env === 'test') updates.env = body.env;
    if (typeof body.name === 'string' && body.name.trim()) updates.name = body.name.trim();
    if (typeof body.r2BaseUrl === 'string') updates.r2BaseUrl = body.r2BaseUrl.trim();

    if (Object.keys(updates).length === 0) {
      return json({ error: 'No valid fields to update' }, 400, origin);
    }

    await updateClientConfig(env.CLIENTS_KV, clientId, updates);
    return json({ id: clientId, ...updates }, 200, origin);
  }

  // POST /api/clients/:id/cors — (re)apply the R2 bucket CORS policy needed
  // for presigned backup upload/download URLs. Safe to call repeatedly —
  // PutBucketCors replaces the whole policy, it never accumulates duplicates.
  if (method === 'POST' && url.pathname.endsWith('/cors') && url.pathname.startsWith('/api/clients/')) {
    if (!await isAuthorized(request, env)) return json({ error: 'Unauthorized' }, 401, origin);

    const clientId = decodeURIComponent(url.pathname.slice('/api/clients/'.length, -'/cors'.length));
    if (!clientId) return json({ error: 'Missing client ID' }, 400, origin);

    const targetClient = await getClient(env.CLIENTS_KV, clientId);
    if (!targetClient) return json({ error: 'Client not found' }, 404, origin);

    const targetCreds = await getClientCredentials(env.CLIENTS_KV, clientId, env.MASTER_KEY);
    if (!targetCreds) return json({ error: 'Client credentials not found' }, 500, origin);

    try {
      const targetS3 = createS3Client(targetCreds, targetClient.endpoint);
      await targetS3.s3PutBucketCors(targetClient.bucketName, ALLOWED_ORIGINS);
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : 'Could not configure bucket CORS' }, 502, origin);
    }

    return json({ ok: true, bucketName: targetClient.bucketName, allowedOrigins: ALLOWED_ORIGINS }, 200, origin);
  }

  // DELETE /api/clients/:id
  if (method === 'DELETE' && url.pathname.startsWith('/api/clients/')) {
    if (!await isAuthorized(request, env)) return json({ error: 'Unauthorized' }, 401, origin);

    const clientId = decodeURIComponent(url.pathname.slice('/api/clients/'.length));
    if (!clientId) return json({ error: 'Missing client ID' }, 400, origin);

    const existing = await getClient(env.CLIENTS_KV, clientId);
    if (!existing) return json({ error: 'Client not found' }, 404, origin);

    await deleteClient(env.CLIENTS_KV, clientId);
    return json({ deleted: clientId }, 200, origin);
  }

  // ── Media endpoints (auth + X-Client-ID required) ─────────────────────────

  if (!await isAuthorized(request, env)) {
    return json({ error: 'Unauthorized' }, 401, origin);
  }

  // Resolve client for media operations
  const clientId = request.headers.get('X-Client-ID');
  if (!clientId) {
    // Only require X-Client-ID for media endpoints below
    const mediaEndpoints = ['/api/list', '/api/upload', '/api/folder', '/api/delete', '/api/restore', '/api/bulk-delete', '/api/folders', '/api/rename', '/api/bulk-rename', '/api/delete-recursive', '/api/rename-folder', '/api/backups', '/api/backups/upload-url', '/api/backups/download-url', '/api/update-cache-header'];
    if (mediaEndpoints.includes(url.pathname) || /^\/api\/trash(?:\/[^/]+(?:\/object)?)?$/.test(url.pathname)) {
      return json({ error: 'Missing X-Client-ID header' }, 400, origin);
    }
    return json({ error: 'Not found' }, 404, origin);
  }

  const client = await getClient(env.CLIENTS_KV, clientId);
  if (!client) return json({ error: 'Client not found' }, 404, origin);

  const creds = await getClientCredentials(env.CLIENTS_KV, clientId, env.MASTER_KEY);
  if (!creds) return json({ error: 'Client credentials not found' }, 500, origin);

  const s3 = createS3Client(creds, client.endpoint);

  // ── GET /api/trash[/:token] — consulta de papelera, sin mutaciones ───────
  const trashPath = /^\/api\/trash(?:\/([^/]+))?$/.exec(url.pathname);
  if (method === 'GET' && trashPath) {
    const limit = trashPath[1]
      ? parseTrashLimit(url.searchParams.get('limit'), 100, 1000)
      : parseTrashLimit(url.searchParams.get('limit'), 20, 100);
    if (limit === null) return json({ error: 'Invalid limit' }, 400, origin);

    const cursor = parseTrashCursor(url.searchParams.get('cursor'));
    if (cursor === null) return json({ error: 'Invalid cursor' }, 400, origin);

    if (!trashPath[1]) {
      try {
        const result = await s3.s3List(client.bucketName, TRASH_PREFIX, '/', limit, cursor);
        if (result.isTruncated && !result.nextContinuationToken) {
          return json({ error: 'Storage returned a truncated page without a cursor' }, 502, origin);
        }
        const groups = result.folders
          .filter(isTrashGroupPrefix)
          .map(prefix => ({
            restoreToken: prefix.slice(TRASH_PREFIX.length, -1),
            count: null,
          }));
        return json({ groups, nextCursor: result.nextContinuationToken ?? null }, 200, origin);
      } catch {
        // Provider errors are intentionally opaque. Without a typed provider
        // error code, a 400 may be a malformed request unrelated to cursor.
        return json({ error: 'Could not list trash' }, 502, origin);
      }
    }

    let token: string;
    try {
      token = decodeURIComponent(trashPath[1]);
    } catch {
      return json({ error: 'Invalid restore token' }, 400, origin);
    }
    if (!UUID_V4.test(token)) return json({ error: 'Invalid restore token' }, 400, origin);

    const trashRoot = `${TRASH_PREFIX}${token}/`;
    try {
      const result = await s3.s3List(client.bucketName, trashRoot, '', limit, cursor);
      if (result.isTruncated && !result.nextContinuationToken) {
        return json({ error: 'Storage returned a truncated page without a cursor' }, 502, origin);
      }
      // A valid group is represented by at least one object. Every returned key
      // must remain inside the requested group before its internal prefix is removed.
      if (result.objects.length === 0) return json({ error: 'Trash group not found' }, 404, origin);
      const items = result.objects
        .filter(object => object.key.startsWith(trashRoot) && object.key.length > trashRoot.length)
        .map(object => ({
          key: object.key.slice(trashRoot.length),
          size: object.size,
          uploaded: object.lastModified || null,
        }));
      if (items.length === 0) return json({ error: 'Trash group not found' }, 404, origin);
      return json({ items, nextCursor: result.nextContinuationToken ?? null }, 200, origin);
    } catch {
      return json({ error: 'Could not list trash group' }, 502, origin);
    }
  }

  // ── GET /api/trash/:restoreToken/object?key=... — miniatura autenticada ──
  // Serves trashed object bytes so the panel can render a thumbnail, without
  // ever exposing them through the public /file/ route. Only objects that
  // resolve strictly inside .mediapanel-trash/{restoreToken}/ of the calling
  // client's own bucket are served; everything else is 404.
  const trashObjectPath = /^\/api\/trash\/([^/]+)\/object$/.exec(url.pathname);
  if (method === 'GET' && trashObjectPath) {
    let token: string;
    try {
      token = decodeURIComponent(trashObjectPath[1]);
    } catch {
      return json({ error: 'Invalid restore token' }, 400, origin);
    }
    if (!RESTORE_TOKEN.test(token)) return json({ error: 'Invalid restore token' }, 400, origin);

    const rawKey = url.searchParams.get('key');
    if (!rawKey) return json({ error: 'Missing key' }, 400, origin);

    const trashRoot = `${TRASH_PREFIX}${token}/`;
    const fullKey = resolveTrashObjectKey(trashRoot, rawKey);
    if (!fullKey) return json({ error: 'Not found' }, 404, origin);

    const res = await s3.s3Get(client.bucketName, fullKey);
    if (!res.ok) return json({ error: 'Not found' }, 404, origin);

    const headers = new Headers(corsHeaders(origin));
    headers.set('Content-Type', res.headers.get('content-type') || 'application/octet-stream');
    // Deleted content of one specific client: never cacheable by a shared cache.
    headers.set('Cache-Control', 'private, no-store');
    return new Response(res.body, { headers });
  }

  // ── GET /api/list?prefix=&limit=50&cursor= ────────────────────────────────
  if (method === 'GET' && url.pathname === '/api/list') {
    const prefix = url.searchParams.get('prefix') ?? '';
    const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '50'), 100);
    const cursor = url.searchParams.get('cursor') ?? undefined;

    const result = await s3.s3List(client.bucketName, prefix, '/', limit, cursor);

    const folders = result.folders.filter(p => !isInternalKey(p)).map(p => ({
      type: 'folder',
      key: p,
      name: p.replace(prefix, '').replace(/\/$/, ''),
    }));

    const files = result.objects
      .filter(o => o.key !== prefix && !o.key.endsWith('/') && !isInternalKey(o.key))
      .map(o => ({
        type: 'file',
        key: o.key,
        name: o.key.replace(prefix, ''),
        size: o.size,
        uploaded: o.lastModified,
        url: `${url.origin}/file/${encodeURIComponent(clientId)}/${o.key.split('/').map(encodeURIComponent).join('/')}`,
      }));

    return json(
      {
        folders,
        files,
        nextCursor: result.nextContinuationToken ?? null,
      },
      200,
      origin,
    );
  }

  // ── POST /api/upload ──────────────────────────────────────────────────────
  if (method === 'POST' && url.pathname === '/api/upload') {
    const contentType = request.headers.get('content-type') ?? '';
    if (!contentType.includes('multipart/form-data')) {
      return json({ error: 'Content-Type must be multipart/form-data' }, 400, origin);
    }

    const formData = await request.formData();
    const file = formData.get('file') as File | null;
    const prefix = (formData.get('prefix') as string | null) ?? '';

    if (!file) return json({ error: 'No file provided' }, 400, origin);
    if (isInternalKey(prefix)) return json({ error: 'Reserved prefix' }, 400, origin);

    const allowedTypes = [
      'image/jpeg',
      'image/png',
      'image/webp',
      'image/gif',
      'image/svg+xml',
      'image/avif',
      'image/heic',
      'image/heif',
      'image/heic-sequence',
      'image/bmp',
      'image/tiff',
    ];

    // Defensivo: algunos browsers (Windows/Linux) reportan file.type === ''
    // para .heic/.heif/.bmp/.tiff. Si viene vacío, inferimos el MIME por extensión.
    let effectiveType = file.type;
    if (!effectiveType) {
      const lowerName = file.name.toLowerCase();
      if (lowerName.endsWith('.heic')) {
        effectiveType = 'image/heic';
      } else if (lowerName.endsWith('.heif')) {
        effectiveType = 'image/heif';
      } else if (lowerName.endsWith('.bmp')) {
        effectiveType = 'image/bmp';
      } else if (lowerName.endsWith('.tif') || lowerName.endsWith('.tiff')) {
        effectiveType = 'image/tiff';
      }
    }

    if (!allowedTypes.includes(effectiveType)) {
      return json({ error: 'Only image files are allowed' }, 400, origin);
    }

    if (file.size > 10 * 1024 * 1024) {
      return json({ error: 'File size exceeds 10MB limit' }, 400, origin);
    }

    const buffer = await file.arrayBuffer();
    const requestedKey = `${prefix}${file.name}`;
    if (isInternalKey(requestedKey)) return json({ error: 'Reserved key' }, 400, origin);

    const overwrite = formData.get('overwrite') === 'true';
    let key = requestedKey;
    let restoreToken: string | undefined;
    const existing = await s3.s3Head(client.bucketName, requestedKey);
    if (existing.status !== 404 && !existing.ok) {
      return json({ error: 'Could not verify upload destination' }, 502, origin);
    }
    if (existing.ok) {
      if (overwrite) {
        if ((client.env ?? 'prod') !== 'test') {
          const confirmedName = request.headers.get('X-Confirmed-Name');
          if (confirmedName !== file.name) {
            return json({ error: 'Production bucket: replacement requires exact filename confirmation' }, 412, origin);
          }
        }
        // Preserve the content being overwritten so a replace can be undone.
        const trashRoot = createTrashRoot();
        await s3.s3Copy(client.bucketName, requestedKey, `${trashRoot}${requestedKey}`);
        restoreToken = trashRoot.slice(TRASH_PREFIX.length, -1);
      } else {
        key = await resolveUniqueKey(s3.s3Head, client.bucketName, requestedKey, new Set());
      }
    }

    // Optional Cache-Control header forwarded from the upload form.
    // The value is allowlisted to prevent arbitrary header injection.
    const rawCacheControl = formData.get('cache-control') as string | null;
    const ALLOWED_CACHE_VALUES = new Set([
      'public, max-age=31536000, immutable',
      'public, max-age=15768000, immutable',
      'public, max-age=2592000, immutable',
    ]);
    const extraHeaders: Record<string, string> = {};
    if (rawCacheControl && ALLOWED_CACHE_VALUES.has(rawCacheControl)) {
      extraHeaders['Cache-Control'] = rawCacheControl;
    }

    await s3.s3Put(client.bucketName, key, buffer, effectiveType || 'application/octet-stream', extraHeaders);

    return json(
      {
        key,
        name: key.split('/').pop() ?? file.name,
        url: `${url.origin}/file/${encodeURIComponent(clientId)}/${key.split('/').map(encodeURIComponent).join('/')}`,
        size: file.size,
        ...(restoreToken ? { restoreToken } : {}),
      },
      201,
      origin,
    );
  }

  // ── POST /api/folder ──────────────────────────────────────────────────────
  if (method === 'POST' && url.pathname === '/api/folder') {
    const { path } = await request.json<{ path: string }>();
    if (!path) return json({ error: 'No path provided' }, 400, origin);

    const key = path.endsWith('/') ? path : `${path}/`;
    if (isInternalKey(key)) return json({ error: 'Reserved prefix' }, 400, origin);
    await s3.s3Put(client.bucketName, key, new ArrayBuffer(0), 'application/x-directory');

    return json({ key, name: key }, 201, origin);
  }

  // ── DELETE /api/delete?key=ruta/archivo.jpg ───────────────────────────────
  if (method === 'DELETE' && url.pathname === '/api/delete') {
    const key = url.searchParams.get('key');
    if (!key) return json({ error: 'No key provided' }, 400, origin);

    // Production buckets require the caller to confirm the exact filename
    if ((client.env ?? 'prod') !== 'test') {
      const confirmedName = request.headers.get('X-Confirmed-Name');
      const expectedName = key.split('/').pop() ?? '';
      if (!confirmedName || confirmedName !== expectedName) {
        return json(
          { error: 'Production bucket: X-Confirmed-Name header must match the filename' },
          412,
          origin,
        );
      }
    }

    // URLSearchParams.get() already percent-decodes the query value. Decode
    // again here would turn a literal key such as `100%20real.jpg` into a
    // different object name.
    const decodedKey = key;
    if (isInternalKey(decodedKey)) return json({ error: 'Reserved key' }, 400, origin);

    const source = await s3.s3Head(client.bucketName, decodedKey);
    if (source.status === 404) return json({ error: 'Object not found' }, 404, origin);
    if (!source.ok) return json({ error: 'Could not verify source object' }, 502, origin);

    const trashRoot = createTrashRoot();
    await s3.s3Copy(client.bucketName, decodedKey, `${trashRoot}${decodedKey}`);
    await s3.s3Delete(client.bucketName, decodedKey);
    return json({ deleted: decodedKey, restoreToken: trashRoot.slice(TRASH_PREFIX.length, -1) }, 200, origin);
  }

  // ── POST /api/restore — restaurar un borrado desde la papelera interna ──
  if (method === 'POST' && url.pathname === '/api/restore') {
    const { restoreToken, overwriteExisting, keys } = await request.json<{
      restoreToken: string;
      overwriteExisting?: boolean;
      keys?: string[];
    }>();
    if (!RESTORE_TOKEN.test(restoreToken ?? '')) {
      return json({ error: 'Invalid restore token' }, 400, origin);
    }
    if (keys !== undefined && (!Array.isArray(keys) || keys.length === 0 || keys.some(k => typeof k !== 'string'))) {
      return json({ error: 'Invalid keys' }, 400, origin);
    }

    const trashRoot = `${TRASH_PREFIX}${restoreToken}/`;
    const trashedObjects = await listAllObjects(s3.s3List, client.bucketName, trashRoot);
    if (trashedObjects.length === 0) return json({ error: 'Deleted item not found' }, 404, origin);

    // Without `keys`, restore the whole group — unchanged behavior relied on
    // by the batch-delete undo already in production. With `keys`, restore
    // only that subset of the group's original keys: reject the entire
    // request (nothing restored) if any requested key is not in this group.
    let selectedObjects = trashedObjects;
    if (keys) {
      const byOriginalKey = new Map(trashedObjects.map(object => [object.key.slice(trashRoot.length), object]));
      const missing = keys.filter(key => !byOriginalKey.has(key));
      if (missing.length > 0) {
        return json({ error: `Keys not found in group: ${missing.join(', ')}` }, 400, origin);
      }
      selectedObjects = Array.from(new Set(keys)).map(key => byOriginalKey.get(key)!);
    }

    const restores = selectedObjects.map(object => ({
      sourceKey: object.key,
      destKey: object.key.slice(trashRoot.length),
    }));

    // Never overwrite content created after the delete — unless the caller
    // explicitly opts in (undoing a Replace, where the destination is expected
    // to hold the content being undone).
    if (!overwriteExisting) {
      for (const { destKey } of restores) {
        const existing = await s3.s3Head(client.bucketName, destKey);
        if (existing.status === 200) {
          return json({ error: `Restore destination already exists: ${destKey}` }, 409, origin);
        }
        if (existing.status !== 404) {
          return json({ error: 'Could not verify restore destination' }, 502, origin);
        }
      }
    }

    // Copy every object first. Originals in the trash are only removed after
    // the complete restore copy succeeds.
    for (const { sourceKey, destKey } of restores) {
      await s3.s3Copy(client.bucketName, sourceKey, destKey);
    }
    for (const { sourceKey } of restores) {
      await s3.s3Delete(client.bucketName, sourceKey);
    }

    return json({ ok: true, restored: restores.map(item => item.destKey) }, 200, origin);
  }

  // ── POST /api/bulk-delete — borrado lógico por lote (una sola papelera) ──
  if (method === 'POST' && url.pathname === '/api/bulk-delete') {
    const { keys } = await request.json<{ keys: string[] }>();
    if (!Array.isArray(keys) || keys.length === 0) return json({ error: 'Missing keys' }, 400, origin);
    if (keys.some(isInternalKey)) return json({ error: 'Reserved key' }, 400, origin);

    // Production buckets require the caller to confirm the exact file count.
    if ((client.env ?? 'prod') !== 'test') {
      const confirmedCount = request.headers.get('X-Confirmed-Count');
      if (confirmedCount !== String(keys.length)) {
        return json(
          { error: 'Production bucket: X-Confirmed-Count header must match the number of files' },
          412,
          origin,
        );
      }
    }

    for (const key of keys) {
      const existing = await s3.s3Head(client.bucketName, key);
      if (existing.status === 404) return json({ error: `Object not found: ${key}` }, 404, origin);
      if (!existing.ok) return json({ error: 'Could not verify source object' }, 502, origin);
    }

    const trashRoot = createTrashRoot();
    for (const key of keys) {
      await s3.s3Copy(client.bucketName, key, `${trashRoot}${key}`);
    }
    for (const key of keys) {
      await s3.s3Delete(client.bucketName, key);
    }

    return json({ ok: true, deleted: keys.length, restoreToken: trashRoot.slice(TRASH_PREFIX.length, -1) }, 200, origin);
  }

  // ── GET /api/folders — lista recursiva de todas las carpetas ────────────
  if (method === 'GET' && url.pathname === '/api/folders') {
    const allFolders: string[] = [];
    const queue: string[] = [''];

    while (queue.length > 0) {
      const prefix = queue.shift()!;
      let cursor: string | undefined;
      do {
        const result = await s3.s3List(client.bucketName, prefix, '/', 1000, cursor);
        for (const folder of result.folders) {
          if (isInternalKey(folder)) continue;
          allFolders.push(folder);
          queue.push(folder);
        }
        cursor = result.nextContinuationToken ?? undefined;
      } while (cursor);
    }

    return json({ folders: allFolders }, 200, origin);
  }

  // ── POST /api/rename — rename/move un archivo ──────────────────────────
  if (method === 'POST' && url.pathname === '/api/rename') {
    const { sourceKey, destKey } = await request.json<{ sourceKey: string; destKey: string }>();
    if (!sourceKey || !destKey) return json({ error: 'Missing sourceKey or destKey' }, 400, origin);
    if (sourceKey === destKey) return json({ error: 'Source and destination must be different' }, 400, origin);
    if (isInternalKey(sourceKey) || isInternalKey(destKey)) return json({ error: 'Reserved key' }, 400, origin);

    const source = await s3.s3Head(client.bucketName, sourceKey);
    if (source.status === 404) return json({ error: 'Source object not found' }, 404, origin);
    if (!source.ok) return json({ error: 'Could not verify source object' }, 502, origin);

    const resolvedKey = await resolveUniqueKey(s3.s3Head, client.bucketName, destKey, new Set([sourceKey]));
    await s3.s3Copy(client.bucketName, sourceKey, resolvedKey);
    await s3.s3Delete(client.bucketName, sourceKey);

    const newUrl = `${url.origin}/file/${encodeURIComponent(clientId)}/${resolvedKey.split('/').map(encodeURIComponent).join('/')}`;
    return json({ ok: true, newKey: resolvedKey, url: newUrl }, 200, origin);
  }

  // ── POST /api/bulk-rename — mover/renombrar varios archivos en una sola request ──
  if (method === 'POST' && url.pathname === '/api/bulk-rename') {
    const { items } = await request.json<{ items: Array<{ sourceKey: string; destKey: string }> }>();
    if (!items?.length) return json({ error: 'Missing items' }, 400, origin);

    // usedInBatch tracks keys already claimed this request so two files
    // moving to the same name don't both resolve to the same candidate.
    const sourceKeys = new Set(items.map(i => i.sourceKey));
    const usedInBatch = new Set<string>();
    const planned: Array<{ sourceKey: string; newKey: string }> = [];
    for (const { sourceKey, destKey } of items) {
      if (!sourceKey || !destKey || sourceKey === destKey) continue;
      if (isInternalKey(sourceKey) || isInternalKey(destKey)) return json({ error: 'Reserved key' }, 400, origin);
      if (sourceKeys.has(destKey) && destKey !== sourceKey) {
        return json({ error: `Destination is also a source key: ${destKey}` }, 409, origin);
      }
      const resolvedKey = await resolveUniqueKey(s3.s3Head, client.bucketName, destKey, new Set([sourceKey]), usedInBatch);
      usedInBatch.add(resolvedKey);
      planned.push({ sourceKey, newKey: resolvedKey });
    }
    for (const { sourceKey, newKey } of planned) {
      await s3.s3Copy(client.bucketName, sourceKey, newKey);
    }
    for (const { sourceKey } of planned) {
      await s3.s3Delete(client.bucketName, sourceKey);
    }
    const results = planned.map(({ newKey }) => ({
      newKey,
      url: `${url.origin}/file/${encodeURIComponent(clientId)}/${newKey.split('/').map(encodeURIComponent).join('/')}`,
    }));
    return json({ ok: true, results }, 200, origin);
  }

  // ── POST /api/delete-recursive — eliminar carpeta y contenido ──────────
  if (method === 'POST' && url.pathname === '/api/delete-recursive') {
    const { prefix: delPrefix } = await request.json<{ prefix: string }>();
    if (!delPrefix) return json({ error: 'Missing prefix' }, 400, origin);
    const normalizedDelPrefix = normalizeFolderPrefix(delPrefix);
    if (isInternalKey(normalizedDelPrefix)) return json({ error: 'Reserved prefix' }, 400, origin);

    // Production buckets require the caller to confirm the exact folder name
    if ((client.env ?? 'prod') !== 'test') {
      const confirmedName = request.headers.get('X-Confirmed-Name');
      const expectedName = normalizedDelPrefix.replace(/\/$/, '').split('/').pop() ?? '';
      if (!confirmedName || confirmedName !== expectedName) {
        return json(
          { error: 'Production bucket: X-Confirmed-Name header must match the folder name' },
          412,
          origin,
        );
      }
    }

    const objects = await listAllObjects(s3.s3List, client.bucketName, normalizedDelPrefix);
    if (objects.length === 0) return json({ error: 'Folder not found' }, 404, origin);

    const trashRoot = createTrashRoot();
    // Complete all copies before deleting any source object. This keeps a
    // failed recursive delete recoverable and avoids mutating a paginated list.
    for (const obj of objects) {
      await s3.s3Copy(client.bucketName, obj.key, `${trashRoot}${obj.key}`);
    }
    for (const obj of objects) {
      await s3.s3Delete(client.bucketName, obj.key);
    }

    return json({
      ok: true,
      deleted: objects.length,
      restoreToken: trashRoot.slice(TRASH_PREFIX.length, -1),
    }, 200, origin);
  }

  // ── POST /api/rename-folder — renombrar carpeta (batch copy+delete) ────
  if (method === 'POST' && url.pathname === '/api/rename-folder') {
    const { oldPrefix, newPrefix } = await request.json<{ oldPrefix: string; newPrefix: string }>();
    if (!oldPrefix || !newPrefix) return json({ error: 'Missing oldPrefix or newPrefix' }, 400, origin);
    const normalizedOldPrefix = normalizeFolderPrefix(oldPrefix);
    const normalizedNewPrefix = normalizeFolderPrefix(newPrefix);
    if (normalizedOldPrefix === normalizedNewPrefix) {
      return json({ error: 'Source and destination folders must be different' }, 400, origin);
    }
    if (isInternalKey(normalizedOldPrefix) || isInternalKey(normalizedNewPrefix)) {
      return json({ error: 'Reserved prefix' }, 400, origin);
    }
    if (normalizedNewPrefix.startsWith(normalizedOldPrefix) || normalizedOldPrefix.startsWith(normalizedNewPrefix)) {
      return json({ error: 'Cannot rename a folder into an overlapping path' }, 400, origin);
    }

    const objects = await listAllObjects(s3.s3List, client.bucketName, normalizedOldPrefix);
    if (objects.length === 0) return json({ error: 'Source folder not found' }, 404, origin);

    const moves = objects.map(obj => ({
      sourceKey: obj.key,
      destKey: normalizedNewPrefix + obj.key.slice(normalizedOldPrefix.length),
    }));

    // Folder renames must never overwrite an existing destination.
    for (const { destKey } of moves) {
      const existing = await s3.s3Head(client.bucketName, destKey);
      if (existing.status === 200) return json({ error: `Destination already exists: ${destKey}` }, 409, origin);
      if (existing.status !== 404) return json({ error: 'Could not verify destination' }, 502, origin);
    }
    for (const { sourceKey, destKey } of moves) {
      await s3.s3Copy(client.bucketName, sourceKey, destKey);
    }
    for (const { sourceKey } of moves) {
      await s3.s3Delete(client.bucketName, sourceKey);
    }

    return json({ ok: true, moved: moves.length, newPrefix: normalizedNewPrefix }, 200, origin);
  }

  // ── Backups — ZIPs privados creados por el navegador ──────────────────
  if (method === 'GET' && url.pathname === '/api/backups') {
    const objects = await listAllObjects(s3.s3List, client.bucketName, BACKUP_PREFIX);
    return json({
      backups: objects
        .filter(obj => obj.key.endsWith('.zip'))
        .sort((a, b) => b.lastModified.localeCompare(a.lastModified))
        .map(obj => ({
          key: obj.key,
          name: obj.key.slice(BACKUP_PREFIX.length),
          size: obj.size,
          createdAt: obj.lastModified,
        })),
    }, 200, origin);
  }

  if (method === 'POST' && url.pathname === '/api/backups/upload-url') {
    const body = await request.json<{ size?: number }>();
    if (!Number.isFinite(body.size) || (body.size ?? 0) <= 0) {
      return json({ error: 'Invalid backup size' }, 400, origin);
    }
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const key = `${BACKUP_PREFIX}backup-${timestamp}.zip`;
    const uploadUrl = await s3.s3Presign(
      client.bucketName,
      key,
      'PUT',
      900,
      { 'Content-Type': 'application/zip' },
    );
    return json({ key, uploadUrl, contentType: 'application/zip' }, 200, origin);
  }

  if (method === 'POST' && url.pathname === '/api/backups/download-url') {
    const { key } = await request.json<{ key: string }>();
    if (!key?.startsWith(BACKUP_PREFIX) || !key.endsWith('.zip')) {
      return json({ error: 'Invalid backup key' }, 400, origin);
    }
    const existing = await s3.s3Head(client.bucketName, key);
    if (existing.status === 404) return json({ error: 'Backup not found' }, 404, origin);
    if (!existing.ok) return json({ error: 'Could not verify backup' }, 502, origin);
    const downloadUrl = await s3.s3Presign(client.bucketName, key, 'GET', 900);
    return json({ downloadUrl }, 200, origin);
  }

  // ── POST /api/update-cache-header ──────────────────────────────────────
  // Body: { key: string, maxAge?: number }
  // Copies the object to itself replacing the Cache-Control header.
  // maxAge defaults to 31536000 (1 year) when omitted for backward compatibility.
  // Uses S3 CopyObject with x-amz-metadata-directive: REPLACE — no content transfer.
  // Call once per key from the browser (1 key = 2 subrequests: HEAD + PUT, well under 50).
  if (method === 'POST' && url.pathname === '/api/update-cache-header') {
    const body = await request.json<{ key: string; maxAge?: number }>();
    if (!body.key) return json({ error: 'Missing key' }, 400, origin);
    if (isInternalKey(body.key)) return json({ error: 'Reserved key' }, 400, origin);

    const ALLOWED_MAX_AGES = new Set([31536000, 15768000, 2592000]);
    const maxAge = typeof body.maxAge === 'number' && ALLOWED_MAX_AGES.has(body.maxAge)
      ? body.maxAge
      : 31536000;

    await s3.s3UpdateMetadata(client.bucketName, body.key, {
      'Cache-Control': `public, max-age=${maxAge}, immutable`,
    });

    return json({ ok: true, key: body.key, maxAge }, 200, origin);
  }

  return json({ error: 'Not found' }, 404, origin);
}
