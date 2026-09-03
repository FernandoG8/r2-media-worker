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

const env = {
  TEAM_DOMAIN: ISSUER,
  POLICY_AUD: AUDIENCE,
} as Env;

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

describe('verifyAccessJwt', () => {
  it('accepts a valid signature, issuer and audience', async () => {
    const token = await signToken();
    await expect(verifyAccessJwt(requestWithToken(token), env, () => resolveJwks)).resolves.toEqual({ ok: true });
  });

  it('rejects a missing assertion', async () => {
    await expect(verifyAccessJwt(requestWithToken(), env, () => resolveJwks)).resolves.toEqual({
      ok: false,
      status: 403,
      error: 'Access token is missing or invalid',
    });
  });

  it('rejects a token for another Access application', async () => {
    const token = await signToken({ audience: 'another-audience' });
    const result = await verifyAccessJwt(requestWithToken(token), env, () => resolveJwks);
    expect(result).toMatchObject({ ok: false, status: 403 });
  });

  it('rejects an expired token', async () => {
    const token = await signToken({ expiration: '0s' });
    const result = await verifyAccessJwt(requestWithToken(token), env, () => resolveJwks);
    expect(result).toMatchObject({ ok: false, status: 403 });
  });

  it('fails closed for an invalid team domain', async () => {
    const result = await verifyAccessJwt(requestWithToken('token'), {
      ...env,
      TEAM_DOMAIN: 'https://example.com/not-access',
    }, () => resolveJwks);
    expect(result).toMatchObject({ ok: false, status: 503 });
  });
});
