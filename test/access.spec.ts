import { beforeAll, describe, expect, it } from 'vitest';
import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWTVerifyGetKey,
} from 'jose';
import { verifyAccessJwt } from '../src/access';
import type { Env } from '../src/types';

const ISSUER = 'https://example.cloudflareaccess.com';
const AUDIENCE = 'access-application-audience';
const KEY_ID = 'test-key';

const baseEnv = {
  TEAM_DOMAIN: ISSUER,
  POLICY_AUD: AUDIENCE,
} as Env;

const enforcedEnv: Env = { ...baseEnv, ACCESS_ENFORCEMENT: 'enabled' };

let privateKey: CryptoKey;
let resolveJwks: JWTVerifyGetKey;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256', { extractable: true });
  privateKey = pair.privateKey;
  const publicJwk = await exportJWK(pair.publicKey);
  publicJwk.kid = KEY_ID;
  publicJwk.alg = 'RS256';
  resolveJwks = createLocalJWKSet({ keys: [publicJwk] });
});

async function signToken(overrides: { issuer?: string; audience?: string; expiration?: string } = {}) {
  return new SignJWT({ email: 'admin@example.com' })
    .setProtectedHeader({ alg: 'RS256', kid: KEY_ID })
    .setIssuer(overrides.issuer ?? ISSUER)
    .setAudience(overrides.audience ?? AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(overrides.expiration ?? '5m')
    .sign(privateKey);
}

function requestWithToken(token?: string) {
  return new Request('https://worker.example/api/list', {
    headers: token ? { 'Cf-Access-Jwt-Assertion': token } : undefined,
  });
}

describe('verifyAccessJwt — enforcement disabled (default)', () => {
  it('passes without an assertion when ACCESS_ENFORCEMENT is absent', async () => {
    await expect(verifyAccessJwt(requestWithToken(), baseEnv, () => resolveJwks)).resolves.toEqual({ ok: true });
  });

  it('passes without an assertion when ACCESS_ENFORCEMENT is any non-"enabled" value', async () => {
    const env = { ...baseEnv, ACCESS_ENFORCEMENT: 'disabled' } as Env;
    await expect(verifyAccessJwt(requestWithToken(), env, () => resolveJwks)).resolves.toEqual({ ok: true });
  });

  it('passes without an assertion even when a typo would have looked "enabled"-ish', async () => {
    const env = { ...baseEnv, ACCESS_ENFORCEMENT: 'Enabled' } as Env;
    await expect(verifyAccessJwt(requestWithToken(), env, () => resolveJwks)).resolves.toEqual({ ok: true });
  });

  it('passes even with a valid assertion present (Access check is skipped, not merely optional)', async () => {
    const token = await signToken();
    await expect(verifyAccessJwt(requestWithToken(token), baseEnv, () => resolveJwks)).resolves.toEqual({ ok: true });
  });

  it('does not fail closed even when TEAM_DOMAIN/POLICY_AUD are missing', async () => {
    const env = { ACCESS_ENFORCEMENT: 'suspended' } as Env;
    await expect(verifyAccessJwt(requestWithToken(), env, () => resolveJwks)).resolves.toEqual({ ok: true });
  });
});

describe('verifyAccessJwt — enforcement enabled', () => {
  it('accepts a valid signature, issuer and audience', async () => {
    const token = await signToken();
    await expect(verifyAccessJwt(requestWithToken(token), enforcedEnv, () => resolveJwks)).resolves.toEqual({ ok: true });
  });

  it('rejects a missing assertion', async () => {
    await expect(verifyAccessJwt(requestWithToken(), enforcedEnv, () => resolveJwks)).resolves.toEqual({
      ok: false,
      status: 403,
      error: 'Access token is missing or invalid',
    });
  });

  it('rejects a token for another Access application', async () => {
    const token = await signToken({ audience: 'another-audience' });
    const result = await verifyAccessJwt(requestWithToken(token), enforcedEnv, () => resolveJwks);
    expect(result).toMatchObject({ ok: false, status: 403 });
  });

  it('rejects an expired token', async () => {
    const token = await signToken({ expiration: '0s' });
    const result = await verifyAccessJwt(requestWithToken(token), enforcedEnv, () => resolveJwks);
    expect(result).toMatchObject({ ok: false, status: 403 });
  });

  it('fails closed for an invalid team domain', async () => {
    const result = await verifyAccessJwt(requestWithToken('token'), {
      ...enforcedEnv,
      TEAM_DOMAIN: 'https://example.com/not-access',
    }, () => resolveJwks);
    expect(result).toMatchObject({ ok: false, status: 503 });
  });

  it('fails closed when TEAM_DOMAIN is missing', async () => {
    const env = { ACCESS_ENFORCEMENT: 'enabled', POLICY_AUD: AUDIENCE } as Env;
    const result = await verifyAccessJwt(requestWithToken('token'), env, () => resolveJwks);
    expect(result).toMatchObject({ ok: false, status: 503 });
  });

  it('fails closed when POLICY_AUD is missing', async () => {
    const env = { ACCESS_ENFORCEMENT: 'enabled', TEAM_DOMAIN: ISSUER } as Env;
    const result = await verifyAccessJwt(requestWithToken('token'), env, () => resolveJwks);
    expect(result).toMatchObject({ ok: false, status: 503 });
  });

  it('fails closed when both TEAM_DOMAIN and POLICY_AUD are missing', async () => {
    const env = { ACCESS_ENFORCEMENT: 'enabled' } as Env;
    const result = await verifyAccessJwt(requestWithToken(), env, () => resolveJwks);
    expect(result).toMatchObject({ ok: false, status: 503 });
  });
});
