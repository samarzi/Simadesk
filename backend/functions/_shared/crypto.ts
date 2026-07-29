/**
 * Symmetric encryption for marketplace API keys (AES-256-GCM).
 *
 * The key lives ONLY in the edge-runtime environment (MP_ENC_KEY) — never in the
 * database and never in the browser. So even a full DB dump leaks only ciphertext,
 * and the browser physically cannot decrypt a stored key.
 *
 * Token format (stored in the *_enc columns):
 *   enc:v1:<base64( iv(12 bytes) || ciphertext+gcmTag )>
 *
 * MP_ENC_KEY must be a base64-encoded 32-byte key. Generate one with:
 *   openssl rand -base64 32
 */

const PREFIX = 'enc:v1:';

let cachedKey: CryptoKey | null = null;

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

async function getKey(): Promise<CryptoKey> {
  if (cachedKey) return cachedKey;
  const raw = Deno.env.get('MP_ENC_KEY');
  if (!raw) throw new Error('MP_ENC_KEY is not set');
  const keyBytes = b64ToBytes(raw.trim());
  if (keyBytes.length !== 32) {
    throw new Error(`MP_ENC_KEY must decode to 32 bytes, got ${keyBytes.length}`);
  }
  cachedKey = await crypto.subtle.importKey(
    'raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'],
  );
  return cachedKey;
}

/** Returns true if the value is already an encrypted token. */
export function isEncrypted(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

/** Encrypt a plaintext secret into an `enc:v1:...` token. */
export async function encryptSecret(plain: string): Promise<string> {
  const key = await getKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = new TextEncoder().encode(plain);
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc),
  );
  const combined = new Uint8Array(iv.length + cipher.length);
  combined.set(iv, 0);
  combined.set(cipher, iv.length);
  return PREFIX + bytesToB64(combined);
}

/**
 * Decrypt an `enc:v1:...` token back to plaintext.
 * If the value is NOT an encrypted token (legacy plaintext during migration),
 * it is returned unchanged — this lets code read both old and new rows safely.
 */
export async function decryptSecret(token: string | null | undefined): Promise<string> {
  if (token == null) return '';
  if (!isEncrypted(token)) return token; // legacy plaintext passthrough
  const key = await getKey();
  const combined = b64ToBytes(token.slice(PREFIX.length));
  const iv = combined.slice(0, 12);
  const cipher = combined.slice(12);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher);
  return new TextDecoder().decode(plain);
}
