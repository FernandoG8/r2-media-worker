import type { Env } from './types';
import { corsHeaders, json, resolveOrigin } from './cors';
import { createS3Client } from './s3';
import { listClients, getClient, getClientCredentials, createClient, deleteClient } from './clients';

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
    }>();

    if (!body.id || !body.name || !body.bucketName || !body.endpoint || !body.accessKeyId || !body.secretAccessKey) {
      return json({ error: 'Missing required fields' }, 400, origin);
    }

    // Check if already exists
    const existing = await getClient(env.CLIENTS_KV, body.id);
    if (existing) return json({ error: 'Client already exists' }, 409, origin);

    await createClient(
      env.CLIENTS_KV,
      body.id,
      {
        name: body.name,
        bucketName: body.bucketName,
        endpoint: body.endpoint,
        r2BaseUrl: body.r2BaseUrl ?? '',
        active: true,
        createdAt: new Date().toISOString(),
      },
      { accessKeyId: body.accessKeyId, secretAccessKey: body.secretAccessKey },
      env.MASTER_KEY,
    );

    return json({ id: body.id, name: body.name }, 201, origin);
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
    if (
      url.pathname === '/api/list' ||
      url.pathname === '/api/upload' ||
      url.pathname === '/api/folder' ||
      url.pathname === '/api/delete'
    ) {
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

    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/svg+xml'];
    if (!allowedTypes.includes(file.type)) {
      return json({ error: 'Only image files are allowed' }, 400, origin);
    }

    if (file.size > 10 * 1024 * 1024) {
      return json({ error: 'File size exceeds 10MB limit' }, 400, origin);
    }

    const buffer = await file.arrayBuffer();
    const key = `${prefix}${file.name}`;

    await s3.s3Put(client.bucketName, key, buffer, file.type || 'application/octet-stream');

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

    await s3.s3Delete(client.bucketName, decodeURIComponent(key));
    return json({ deleted: key }, 200, origin);
  }

  return json({ error: 'Not found' }, 404, origin);
}
