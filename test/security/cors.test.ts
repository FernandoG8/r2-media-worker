import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { AUTH_HEADERS } from '../helpers/factories';

describe('CORS en todas las respuestas [S-W-12, S-W-14, S-W-15]', () => {
  it('respuesta 200 incluye Access-Control-Allow-Origin', async () => {
    const res = await SELF.fetch('https://example.com/api/clients', {
      headers: { ...AUTH_HEADERS, Origin: 'https://panel.mizcor.dev' },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://panel.mizcor.dev');
  });

  it('respuesta 401 incluye Access-Control-Allow-Origin', async () => {
    const res = await SELF.fetch('https://example.com/api/clients', {
      headers: { Origin: 'https://panel.mizcor.dev' },
    });

    expect(res.status).toBe(401);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://panel.mizcor.dev');
  });

  it('respuesta 400 incluye Access-Control-Allow-Origin', async () => {
    const res = await SELF.fetch('https://example.com/api/upload', {
      method: 'POST',
      headers: { ...AUTH_HEADERS, Origin: 'https://panel.mizcor.dev' },
      body: '{}',
    });

    expect(res.status).toBe(400);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://panel.mizcor.dev');
  });

  it('OPTIONS devuelve 204 con headers CORS completos', async () => {
    const res = await SELF.fetch('https://example.com/any/path', {
      method: 'OPTIONS',
      headers: { Origin: 'http://localhost:5173' },
    });

    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173');
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('OPTIONS');
    expect(res.headers.get('Access-Control-Allow-Headers')).toContain('X-API-Key');
  });

  it('origen no autorizado recibe fallback CORS (no wildcard)', async () => {
    const res = await SELF.fetch('https://example.com/api/clients', {
      headers: { ...AUTH_HEADERS, Origin: 'https://evil.com' },
    });

    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://panel.mizcor.dev');
    expect(res.headers.get('Access-Control-Allow-Origin')).not.toBe('*');
    expect(res.headers.get('Access-Control-Allow-Origin')).not.toBe('https://evil.com');
  });

  it('GET /file/:clientId/:key es accesible sin autenticación (decisión de diseño)', async () => {
    // Intencional: URLs públicas para embeber imágenes en sitios de clientes. Ver INFORME_PRUEBAS.md §4.2 S-W-15.
    const res = await SELF.fetch('https://example.com/file/non-existent-client/missing.png');

    expect(res.status).not.toBe(401);
    expect([200, 404]).toContain(res.status);
  });
});
