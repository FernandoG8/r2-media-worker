import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { AUTH_HEADERS } from '../helpers/factories';

describe('autenticación — confidencialidad [S-W-01..03]', () => {
  it('rechaza request sin X-API-Key con 401', async () => {
    const res = await SELF.fetch('https://example.com/api/clients');

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: 'Unauthorized' });
  });

  it('rechaza request con X-API-Key incorrecto con 401', async () => {
    const res = await SELF.fetch('https://example.com/api/clients', {
      headers: { 'X-API-Key': 'wrong-key' },
    });

    expect(res.status).toBe(401);
  });

  it('rechaza request con X-API-Key vacío con 401', async () => {
    // El escenario H-2.5 (secret del entorno vacío + header vacío) no se puede
    // provocar aquí: el config de test define API_SECRET no vacío.
    const res = await SELF.fetch('https://example.com/api/clients', {
      headers: { 'X-API-Key': '' },
    });

    expect(res.status).toBe(401);
  });

  it('acepta request con X-API-Key correcto', async () => {
    const res = await SELF.fetch('https://example.com/api/clients', {
      headers: AUTH_HEADERS,
    });

    expect(res.status).toBe(200);
  });
});
