/**
 * Simple AES-256-GCM encryption for API keys stored in the database.
 */

import * as crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

/**
 * Get the encryption key from environment or generate a deterministic one from the data dir.
 * In production, users should set ENCRYPTION_KEY in .env.
 */
function getEncryptionKey(): Buffer {
  const envKey = process.env.ENCRYPTION_KEY;
  if (envKey) {
    // If provided, use SHA-256 hash to ensure exactly 32 bytes
    return crypto.createHash('sha256').update(envKey).digest();
  }
  // Fallback: derive from ANTHROPIC_API_KEY (not ideal but better than plaintext)
  const fallback = process.env.ANTHROPIC_API_KEY || 'loop-gateway-default-key';
  return crypto.createHash('sha256').update(fallback).digest();
}

/**
 * Encrypt a plaintext string. Returns base64-encoded ciphertext.
 */
export function encrypt(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(plaintext, 'utf8');
  encrypted = Buffer.concat([encrypted, cipher.final()]);
  const authTag = cipher.getAuthTag();

  // Format: iv + authTag + ciphertext, base64 encoded
  const result = Buffer.concat([iv, authTag, encrypted]);
  return result.toString('base64');
}

/**
 * Decrypt a base64-encoded ciphertext. Returns plaintext string.
 */
export function decrypt(ciphertext: string): string {
  const key = getEncryptionKey();
  const data = Buffer.from(ciphertext, 'base64');

  const iv = data.subarray(0, IV_LENGTH);
  const authTag = data.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const encrypted = data.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(encrypted);
  decrypted = Buffer.concat([decrypted, decipher.final()]);
  return decrypted.toString('utf8');
}
