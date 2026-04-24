import { describe, expect, it } from 'vitest';
import { resolveOrigin, corsHeaders } from '../../src/cors';
import type { Env } from '../../src/types';

// Helper para construir un env parcial sin campos no relevantes para CORS
function makeEnv(allowedOrigin: string): Env {
  return { ALLOWED_ORIGIN: allowedOrigin } as Partial<Env> as Env;
}

// ─── U-W-04 — resolveOrigin ───────────────────────────────────────────────────

describe('resolveOrigin [U-W-04]', () => {
  it('retorna el origen cuando esta en la allowlist hardcoded (panel.mizcor.dev)', () => {
    const req = new Request('https://example.com', {
      headers: { Origin: 'https://panel.mizcor.dev' },
    });
    const origin = resolveOrigin(req, makeEnv(''));
    expect(origin).toBe('https://panel.mizcor.dev');
  });

  it('retorna el origen cuando esta en la allowlist hardcoded (localhost:5173)', () => {
    const req = new Request('https://example.com', {
      headers: { Origin: 'http://localhost:5173' },
    });
    const origin = resolveOrigin(req, makeEnv(''));
    expect(origin).toBe('http://localhost:5173');
  });

  it('retorna el origen cuando coincide con env.ALLOWED_ORIGIN', () => {
    const req = new Request('https://example.com', {
      headers: { Origin: 'https://staging.mizcor.dev' },
    });
    const origin = resolveOrigin(req, makeEnv('https://staging.mizcor.dev'));
    expect(origin).toBe('https://staging.mizcor.dev');
  });

  it('retorna el fallback cuando el origen no esta autorizado', () => {
    const req = new Request('https://example.com', {
      headers: { Origin: 'https://evil.com' },
    });
    const origin = resolveOrigin(req, makeEnv(''));
    expect(origin).toBe('https://panel.mizcor.dev');
  });

  it('retorna el fallback cuando el header Origin esta ausente', () => {
    const req = new Request('https://example.com');
    const origin = resolveOrigin(req, makeEnv(''));
    expect(origin).toBe('https://panel.mizcor.dev');
  });

  it('retorna el fallback cuando el header Origin es vacio', () => {
    const req = new Request('https://example.com', {
      headers: { Origin: '' },
    });
    const origin = resolveOrigin(req, makeEnv(''));
    expect(origin).toBe('https://panel.mizcor.dev');
  });
});

// ─── U-W-05 — corsHeaders ─────────────────────────────────────────────────────

describe('corsHeaders [U-W-05]', () => {
  it('incluye Access-Control-Allow-Origin reflejando el parametro', () => {
    const headers = corsHeaders('https://panel.mizcor.dev');
    expect(headers['Access-Control-Allow-Origin']).toBe('https://panel.mizcor.dev');
  });

  it('incluye los metodos esperados en Access-Control-Allow-Methods', () => {
    const { 'Access-Control-Allow-Methods': methods } = corsHeaders('https://panel.mizcor.dev');
    expect(methods).toContain('GET');
    expect(methods).toContain('POST');
    expect(methods).toContain('DELETE');
    expect(methods).toContain('PATCH');
    expect(methods).toContain('OPTIONS');
  });

  it('incluye los headers esperados en Access-Control-Allow-Headers', () => {
    const { 'Access-Control-Allow-Headers': allowed } = corsHeaders('https://panel.mizcor.dev');
    expect(allowed).toContain('X-API-Key');
    expect(allowed).toContain('X-Client-ID');
    expect(allowed).toContain('X-Confirmed-Name');
    expect(allowed).toContain('Content-Type');
  });

  it('incluye Vary: Origin', () => {
    const headers = corsHeaders('https://panel.mizcor.dev');
    expect(headers['Vary']).toBe('Origin');
  });

  it('NO incluye Access-Control-Allow-Credentials', () => {
    const headers = corsHeaders('https://panel.mizcor.dev');
    expect(Object.keys(headers)).not.toContain('Access-Control-Allow-Credentials');
  });
});
