import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { AUTH_HEADERS } from '../helpers/factories';

// ─── I-W-11 — Autorización global ─────────────────────────────────────────────

const protectedRoutes = [
  { method: 'GET',    path: '/api/clients' },
  { method: 'POST',   path: '/api/clients' },
  { method: 'GET',    path: '/api/list' },
  { method: 'POST',   path: '/api/upload' },
  { method: 'DELETE', path: '/api/delete' },
  { method: 'POST',   path: '/api/folder' },
  { method: 'POST',   path: '/api/rename' },
  { method: 'POST',   path: '/api/delete-recursive' },
  { method: 'POST',   path: '/api/rename-folder' },
  { method: 'POST',   path: '/api/download-zip' },
  { method: 'POST',   path: '/api/update-cache-header' },
];

describe('autorizacion global [I-W-11]', () => {
  it.each(protectedRoutes)(
    'rechaza $method $path sin X-API-Key con 401',
    async ({ method, path }) => {
      const res = await SELF.fetch(`https://example.com${path}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
      });
      expect(res.status).toBe(401);
    },
  );

  it.each(protectedRoutes)(
    'rechaza $method $path con X-API-Key incorrecto con 401',
    async ({ method, path }) => {
      const res = await SELF.fetch(`https://example.com${path}`, {
        method,
        headers: { 'X-API-Key': 'wrong-key', 'Content-Type': 'application/json' },
      });
      expect(res.status).toBe(401);
    },
  );
});

// ─── I-W-12 — CORS en todas las respuestas ────────────────────────────────────

describe('headers CORS en todas las respuestas [I-W-12]', () => {
  it('incluye Access-Control-Allow-Origin en respuesta 200', async () => {
    const res = await SELF.fetch('https://example.com/api/clients', {
      headers: { ...AUTH_HEADERS, 'Origin': 'https://panel.mizcor.dev' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://panel.mizcor.dev');
  });

  it('incluye Access-Control-Allow-Origin en respuesta 401', async () => {
    const res = await SELF.fetch('https://example.com/api/clients', {
      headers: { 'Origin': 'https://panel.mizcor.dev' },
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://panel.mizcor.dev');
  });

  it('incluye Access-Control-Allow-Origin en respuesta 400', async () => {
    // POST /api/clients con body vacío → 400
    const res = await SELF.fetch('https://example.com/api/clients', {
      method: 'POST',
      headers: { ...AUTH_HEADERS, 'Origin': 'https://panel.mizcor.dev' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://panel.mizcor.dev');
  });

  it('devuelve 204 y headers CORS en preflight OPTIONS', async () => {
    const res = await SELF.fetch('https://example.com/api/clients', {
      method: 'OPTIONS',
      headers: { 'Origin': 'http://localhost:5173' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173');
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('OPTIONS');
  });

  it('usa el fallback de origen cuando el Origin no esta en la allowlist', async () => {
    const res = await SELF.fetch('https://example.com/api/clients', {
      headers: { 'Origin': 'https://evil.com' },
    });
    // resolveOrigin devuelve ALLOWED_ORIGINS[0] = 'https://panel.mizcor.dev' como fallback
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://panel.mizcor.dev');
  });
});
