import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey, type RemoteJWKSet } from 'jose';
import type { Env } from './types';

type AccessConfig = {
  issuer: string;
  audience: string;
};

export type AccessVerification =
  | { ok: true }
  | { ok: false; status: 403 | 503; error: 'Access configuration is missing or invalid' | 'Access token is missing or invalid' };

export type AccessJwksResolver = (issuer: string) => JWTVerifyGetKey;

// This is key material cache only, never request or user state. `jose` also
// observes the JWKS cache headers and refreshes it on an unknown `kid`.
const remoteJwksByIssuer = new Map<string, RemoteJWKSet>();

function getAccessConfig(env: Env): AccessConfig | null {
  const audience = env.POLICY_AUD?.trim();
  const rawIssuer = env.TEAM_DOMAIN?.trim();
  if (!audience || !rawIssuer) return null;

  try {
    const issuerUrl = new URL(rawIssuer);
    const isCloudflareAccessDomain = issuerUrl.protocol === 'https:'
      && issuerUrl.hostname.endsWith('.cloudflareaccess.com')
      && issuerUrl.username === ''
      && issuerUrl.password === ''
      && (issuerUrl.pathname === '/' || issuerUrl.pathname === '');
    if (!isCloudflareAccessDomain) return null;
    return { issuer: issuerUrl.origin, audience };
  } catch {
    return null;
  }
}

function getRemoteJwks(issuer: string): RemoteJWKSet {
  const cached = remoteJwksByIssuer.get(issuer);
  if (cached) return cached;

  const jwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
  remoteJwksByIssuer.set(issuer, jwks);
  return jwks;
}

/**
 * Verify the Cloudflare Access assertion sent to an origin. `CF_Authorization`
 * is intentionally not read: Cloudflare documents the assertion header as the
 * reliable origin-facing token.
 */
export async function verifyAccessJwt(
  request: Request,
  env: Env,
  resolveJwks: AccessJwksResolver = getRemoteJwks,
): Promise<AccessVerification> {
  const config = getAccessConfig(env);
  if (!config) {
    return { ok: false, status: 503, error: 'Access configuration is missing or invalid' };
  }

  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) {
    return { ok: false, status: 403, error: 'Access token is missing or invalid' };
  }

  try {
    await jwtVerify(token, resolveJwks(config.issuer), {
      issuer: config.issuer,
      audience: config.audience,
    });
    return { ok: true };
  } catch {
    // Do not disclose signature, claim, or JWKS-fetch details to callers.
    return { ok: false, status: 403, error: 'Access token is missing or invalid' };
  }
}
