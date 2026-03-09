export interface Env {
  BUCKET: R2Bucket;          // temporal — se elimina tras validar S3
  CLIENTS_KV: KVNamespace;
  ALLOWED_ORIGIN: string;
  API_SECRET: string;
  MASTER_KEY: string;        // AES-256 key en base64
}

export interface ClientConfig {
  name: string;
  bucketName: string;
  endpoint: string;          // https://<account_id>.r2.cloudflarestorage.com
  r2BaseUrl: string;         // URL pública base para enlaces
  active: boolean;
  createdAt: string;
}

export interface ClientCredentials {
  accessKeyId: string;
  secretAccessKey: string;
}

export interface EncryptedBlob {
  iv: string;   // base64
  data: string;  // base64
}
