import { describe, expect, it } from 'vitest';
import { isAuthorized } from '../../src/router';
import type { Env } from '../../src/types';

function makeEnv(apiSecret: string): Env {
  return { API_SECRET: apiSecret } as Partial<Env> as Env;
}

function makeRequest(apiKey?: string): Request {
  const headers: Record<string, string> = {};
  if (apiKey !== undefined) headers['X-API-Key'] = apiKey;
  return new Request('https://example.com', { headers });
}

// ─── U-W-06 — isAuthorized ────────────────────────────────────────────────────

describe('isAuthorized [U-W-06]', () => {
  it('retorna true con X-API-Key correcto', () => {
    const req = makeRequest('super-secret-key');
    const env = makeEnv('super-secret-key');
    expect(isAuthorized(req, env)).toBe(true);
  });

  it('retorna false con X-API-Key incorrecto', () => {
    const req = makeRequest('wrong-key');
    const env = makeEnv('super-secret-key');
    expect(isAuthorized(req, env)).toBe(false);
  });

  it('retorna false cuando X-API-Key esta ausente', () => {
    const req = makeRequest();
    const env = makeEnv('super-secret-key');
    expect(isAuthorized(req, env)).toBe(false);
  });

  it('retorna false cuando X-API-Key es cadena vacia', () => {
    const req = makeRequest('');
    const env = makeEnv('super-secret-key');
    expect(isAuthorized(req, env)).toBe(false);
  });

  /**
   * HALLAZGO H-2.5 (seguridad):
   * Cuando env.API_SECRET no está configurado (cadena vacía) y el cliente
   * envía el header X-API-Key también vacío, isAuthorized retorna true.
   * Esto ocurre porque la implementación actual usa `=== env.API_SECRET`
   * sin validar que el secret sea truthy.
   *
   * Este test documenta el COMPORTAMIENTO ACTUAL, no la intención de
   * diseño. La corrección debe registrarse como Decision Record separado
   * (propuesta: `headers.get('X-API-Key') === env.API_SECRET && !!env.API_SECRET`,
   * o preferiblemente una comparación en tiempo constante para evitar
   * timing attacks sobre el secret real).
   *
   * Cuando se aplique la corrección, este test debe actualizar su
   * aserción a `toBe(false)` en el mismo commit que el fix.
   */
  it('autentica con env.API_SECRET vacío y header vacío (hallazgo H-2.5)', () => {
    const env = { API_SECRET: '' } as unknown as Env;
    const request = new Request('https://example.com', {
      headers: { 'X-API-Key': '' },
    });
    expect(isAuthorized(request, env)).toBe(true);
  });

  it('es case-sensitive en el valor de la key', () => {
    const req = makeRequest('ABC123');
    const env = makeEnv('abc123');
    expect(isAuthorized(req, env)).toBe(false);
  });

  it('trata el nombre del header como case-insensitive (estandar HTTP)', () => {
    // La Fetch API normaliza los nombres de header a minusculas internamente.
    // request.headers.get('X-API-Key') == request.headers.get('x-api-key').
    const req = new Request('https://example.com', {
      headers: { 'x-api-key': 'abc123' },
    });
    const env = makeEnv('abc123');
    expect(isAuthorized(req, env)).toBe(true);
  });
});
