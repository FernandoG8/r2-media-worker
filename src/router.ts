import type { Env } from './types';
import { corsHeaders, json, resolveOrigin } from './cors';
import { createS3Client } from './s3';
import { listClients, getClient, getClientCredentials, createClient, deleteClient, updateClientConfig } from './clients';
import { zipSync } from 'fflate';

function isAuthorized(request: Request, env: Env): boolean {
  return request.headers.get('X-API-Key') === env.API_SECRET;
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

    const client = await getClient(env.CLIENTS_KV, clientId);
    if (!client) return json({ error: 'Client not found' }, 404, origin);

    const creds = await getClientCredentials(env.CLIENTS_KV, clientId, env.MASTER_KEY);
    if (!creds) return json({ error: 'Client credentials not found' }, 500, origin);

    const s3 = createS3Client(creds, client.endpoint);
    const res = await s3.s3Get(client.bucketName, key);

    if (!res.ok) return json({ error: 'Not found' }, 404, origin);

    const headers = new Headers(corsHeaders(origin));
    const ct = res.headers.get('content-type');
    if (ct) headers.set('content-type', ct);
    headers.set('cache-control', 'public, max-age=31536000');

    return new Response(res.body, { headers });
  }

  // ── Client management endpoints (auth required, no X-Client-ID) ───────────

  // GET /api/clients
  if (method === 'GET' && url.pathname === '/api/clients') {
    if (!isAuthorized(request, env)) return json({ error: 'Unauthorized' }, 401, origin);
    const clients = await listClients(env.CLIENTS_KV);
    return json(clients, 200, origin);
  }

  // POST /api/clients
  if (method === 'POST' && url.pathname === '/api/clients') {
    if (!isAuthorized(request, env)) return json({ error: 'Unauthorized' }, 401, origin);

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

    return json({ id: body.id, name: body.name }, 201, origin);
  }

  // PATCH /api/clients/:id — update mutable fields (env) without re-entering credentials
  if (method === 'PATCH' && url.pathname.startsWith('/api/clients/')) {
    if (!isAuthorized(request, env)) return json({ error: 'Unauthorized' }, 401, origin);

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

  // DELETE /api/clients/:id
  if (method === 'DELETE' && url.pathname.startsWith('/api/clients/')) {
    if (!isAuthorized(request, env)) return json({ error: 'Unauthorized' }, 401, origin);

    const clientId = decodeURIComponent(url.pathname.slice('/api/clients/'.length));
    if (!clientId) return json({ error: 'Missing client ID' }, 400, origin);

    const existing = await getClient(env.CLIENTS_KV, clientId);
    if (!existing) return json({ error: 'Client not found' }, 404, origin);

    await deleteClient(env.CLIENTS_KV, clientId);
    return json({ deleted: clientId }, 200, origin);
  }

  // ── Media endpoints (auth + X-Client-ID required) ─────────────────────────

  if (!isAuthorized(request, env)) {
    return json({ error: 'Unauthorized' }, 401, origin);
  }

  // Resolve client for media operations
  const clientId = request.headers.get('X-Client-ID');
  if (!clientId) {
    // Only require X-Client-ID for media endpoints below
    const mediaEndpoints = ['/api/list', '/api/upload', '/api/folder', '/api/delete', '/api/folders', '/api/rename', '/api/delete-recursive', '/api/rename-folder', '/api/download-zip', '/api/update-cache-header'];
    if (mediaEndpoints.includes(url.pathname)) {
      return json({ error: 'Missing X-Client-ID header' }, 400, origin);
    }
    return json({ error: 'Not found' }, 404, origin);
  }

  const client = await getClient(env.CLIENTS_KV, clientId);
  if (!client) return json({ error: 'Client not found' }, 404, origin);

  const creds = await getClientCredentials(env.CLIENTS_KV, clientId, env.MASTER_KEY);
  if (!creds) return json({ error: 'Client credentials not found' }, 500, origin);

  const s3 = createS3Client(creds, client.endpoint);

  // ── GET /api/list?prefix=&limit=50&cursor= ────────────────────────────────
  if (method === 'GET' && url.pathname === '/api/list') {
    const prefix = url.searchParams.get('prefix') ?? '';
    const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '50'), 100);
    const cursor = url.searchParams.get('cursor') ?? undefined;

    const result = await s3.s3List(client.bucketName, prefix, '/', limit, cursor);

    const folders = result.folders.map(p => ({
      type: 'folder',
      key: p,
      name: p.replace(prefix, '').replace(/\/$/, ''),
    }));

    const files = result.objects
      .filter(o => o.key !== prefix && !o.key.endsWith('/'))
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

    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/svg+xml', 'image/avif'];
    if (!allowedTypes.includes(file.type)) {
      return json({ error: 'Only image files are allowed' }, 400, origin);
    }

    if (file.size > 10 * 1024 * 1024) {
      return json({ error: 'File size exceeds 10MB limit' }, 400, origin);
    }

    const buffer = await file.arrayBuffer();
    const key = `${prefix}${file.name}`;

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

    await s3.s3Put(client.bucketName, key, buffer, file.type || 'application/octet-stream', extraHeaders);

    return json(
      {
        key,
        name: file.name,
        url: `${url.origin}/file/${encodeURIComponent(clientId)}/${key.split('/').map(encodeURIComponent).join('/')}`,
        size: file.size,
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
      const expectedName = decodeURIComponent(key).split('/').pop() ?? '';
      if (!confirmedName || confirmedName !== expectedName) {
        return json(
          { error: 'Production bucket: X-Confirmed-Name header must match the filename' },
          412,
          origin,
        );
      }
    }

    await s3.s3Delete(client.bucketName, decodeURIComponent(key));
    return json({ deleted: key }, 200, origin);
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

    await s3.s3Copy(client.bucketName, sourceKey, destKey);
    await s3.s3Delete(client.bucketName, sourceKey);

    const newUrl = `${url.origin}/file/${encodeURIComponent(clientId)}/${destKey.split('/').map(encodeURIComponent).join('/')}`;
    return json({ ok: true, newKey: destKey, url: newUrl }, 200, origin);
  }

  // ── POST /api/delete-recursive — eliminar carpeta y contenido ──────────
  if (method === 'POST' && url.pathname === '/api/delete-recursive') {
    const { prefix: delPrefix } = await request.json<{ prefix: string }>();
    if (!delPrefix) return json({ error: 'Missing prefix' }, 400, origin);

    // Production buckets require the caller to confirm the exact folder name
    if ((client.env ?? 'prod') !== 'test') {
      const confirmedName = request.headers.get('X-Confirmed-Name');
      const expectedName = delPrefix.replace(/\/$/, '').split('/').pop() ?? '';
      if (!confirmedName || confirmedName !== expectedName) {
        return json(
          { error: 'Production bucket: X-Confirmed-Name header must match the folder name' },
          412,
          origin,
        );
      }
    }

    let deleted = 0;
    let cursor: string | undefined;
    do {
      const result = await s3.s3List(client.bucketName, delPrefix, '', 1000, cursor);
      for (const obj of result.objects) {
        await s3.s3Delete(client.bucketName, obj.key);
        deleted++;
      }
      cursor = result.nextContinuationToken ?? undefined;
    } while (cursor);

    // Delete the folder marker itself
    try { await s3.s3Delete(client.bucketName, delPrefix); } catch {}
    return json({ ok: true, deleted }, 200, origin);
  }

  // ── POST /api/rename-folder — renombrar carpeta (batch copy+delete) ────
  if (method === 'POST' && url.pathname === '/api/rename-folder') {
    const { oldPrefix, newPrefix } = await request.json<{ oldPrefix: string; newPrefix: string }>();
    if (!oldPrefix || !newPrefix) return json({ error: 'Missing oldPrefix or newPrefix' }, 400, origin);

    let moved = 0;
    let cursor: string | undefined;
    do {
      const result = await s3.s3List(client.bucketName, oldPrefix, '', 1000, cursor);
      for (const obj of result.objects) {
        const newKey = newPrefix + obj.key.slice(oldPrefix.length);
        await s3.s3Copy(client.bucketName, obj.key, newKey);
        await s3.s3Delete(client.bucketName, obj.key);
        moved++;
      }
      cursor = result.nextContinuationToken ?? undefined;
    } while (cursor);

    // Create new folder marker, delete old one
    await s3.s3Put(client.bucketName, newPrefix, new ArrayBuffer(0), 'application/x-directory');
    try { await s3.s3Delete(client.bucketName, oldPrefix); } catch {}
    return json({ ok: true, moved }, 200, origin);
  }

  // ── POST /api/download-zip ─────────────────────────────────────────────
  // Body: { keys?: string[], prefix?: string, name?: string }
  //   keys   → download these specific R2 keys
  //   prefix → list all objects under prefix and download all (backup)
  //   name   → ZIP filename (default: backup.zip)
  if (method === 'POST' && url.pathname === '/api/download-zip') {
    const body = await request.json<{ keys?: string[]; prefix?: string; name?: string }>();
    const zipName = (body.name ?? 'backup').replace(/\.zip$/i, '') + '.zip';

    // Resolve the list of keys to include
    let keys: string[] = [];

    if (Array.isArray(body.keys) && body.keys.length > 0) {
      keys = body.keys;
    } else if (typeof body.prefix === 'string') {
      // List all objects recursively under the given prefix
      let cursor: string | undefined;
      do {
        const result = await s3.s3List(client.bucketName, body.prefix, '', 1000, cursor);
        for (const obj of result.objects) {
          if (!obj.key.endsWith('/')) keys.push(obj.key); // skip folder markers
        }
        cursor = result.nextContinuationToken ?? undefined;
      } while (cursor);
    } else {
      return json({ error: 'Provide keys[] or prefix' }, 400, origin);
    }

    if (keys.length === 0) return json({ error: 'No files found' }, 404, origin);

    // Fetch all files from R2, then build the ZIP synchronously.
    // We use env.BUCKET (R2 binding) instead of the S3 API because:
    //   - S3 API calls count as subrequests (free plan limit: 50/invocation)
    //   - R2 binding calls are internal and have no subrequest limit
    const entries: Record<string, Uint8Array> = {};

    for (const key of keys) {
      const obj = await env.BUCKET.get(key);
      if (!obj) continue;
      const buffer = await obj.arrayBuffer();
      entries[key] = new Uint8Array(buffer);
    }

    if (Object.keys(entries).length === 0) {
      return json({ error: 'No files could be fetched from R2' }, 500, origin);
    }

    // level: 0 = store only — images are already compressed, re-compressing
    // wastes CPU with no size benefit.
    const zipped = zipSync(entries, { level: 0 });

    const zipHeaders = new Headers(corsHeaders(origin));
    zipHeaders.set('content-type', 'application/zip');
    zipHeaders.set('content-disposition', `attachment; filename="${zipName}"`);

    return new Response(zipped, { status: 200, headers: zipHeaders });
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
