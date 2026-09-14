export interface Env {
  CLIENTS_KV: KVNamespace;
  ALLOWED_ORIGIN: string;
  API_SECRET: string;
  MASTER_KEY: string;        // AES-256 key en base64
  /** `https://<team>.cloudflareaccess.com`, set outside source control. */
  TEAM_DOMAIN: string;
  /** Access Application audience (`aud`) for this Worker API. */
  POLICY_AUD: string;
  /**
   * Explicit opt-in switch for Cloudflare Access enforcement on `/api/*`.
   * Must be exactly `"enabled"` for `verifyAccessJwt` to run; any other value
   * (including absence) suspends enforcement. This is intentionally opt-in
   * rather than inferred from `TEAM_DOMAIN`/`POLICY_AUD` presence, so a typo
   * in those variables cannot silently disable protection. When enabled,
   * missing or invalid `TEAM_DOMAIN`/`POLICY_AUD` still fail closed (503).
   */
  ACCESS_ENFORCEMENT: string;
}

export interface ClientConfig {
  name: string;
  bucketName: string;
  endpoint: string;          // https://<account_id>.r2.cloudflarestorage.com
  r2BaseUrl: string;         // URL pública base para enlaces
  active: boolean;
  createdAt: string;
  env?: 'prod' | 'test';     // missing = prod (fail-safe default)
}

export interface ClientCredentials {
  accessKeyId: string;
  secretAccessKey: string;
}

export interface EncryptedBlob {
  iv: string;   // base64
  data: string;  // base64
}
