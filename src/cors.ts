import type { Env } from './types';

const ALLOWED_ORIGINS = [
  'https://panel.mizcor.dev',
  'http://localhost:5173',
];

export function resolveOrigin(request: Request, env: Env): string {
  const reqOrigin = request.headers.get('Origin') ?? '';
  // Check against allowed list; fall back to env config or wildcard
  if (ALLOWED_ORIGINS.includes(reqOrigin)) return reqOrigin;
  if (env.ALLOWED_ORIGIN && reqOrigin === env.ALLOWED_ORIGIN) return reqOrigin;
  return ALLOWED_ORIGINS[0];
}

export function corsHeaders(origin: string) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-API-Key, X-Client-ID',
    'Vary': 'Origin',
  };
}

export function json(data: unknown, status = 200, origin = '*') {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}
