import type { Env } from './types';

export const ALLOWED_ORIGINS = [
  'https://panel.mizcor.dev',
  'https://panel-v2.mizcor.dev',
  'http://localhost:5173',
  'http://localhost:5180',
];

export function resolveOrigin(request: Request, env: Env): string {
  const reqOrigin = request.headers.get('Origin') ?? '';
  // Check against allowed list; fall back to env config or wildcard
  if (ALLOWED_ORIGINS.includes(reqOrigin)) return reqOrigin;
  const configuredOrigin = env.ALLOWED_ORIGIN?.replace(/\/$/, '');
  if (configuredOrigin && reqOrigin === configuredOrigin) return reqOrigin;
  return ALLOWED_ORIGINS[0];
}

export function corsHeaders(origin: string) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, PATCH, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-API-Key, X-Client-ID, X-Confirmed-Name, X-Confirmed-Count',
    'Vary': 'Origin',
  };
}

export function json(data: unknown, status = 200, origin = '*') {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}
