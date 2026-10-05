import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { getConfig } from "./config.js";

/**
 * Authenticated encryption for secrets kept in the store (Vinted tokens and
 * session cookies of accounts connected through the panel).
 *
 * AES-256-GCM with a fresh random IV per value. The payload is
 * `v1.<iv>.<tag>.<ciphertext>`, all base64url. A wrong key or any tampering
 * fails the auth tag check and throws, rather than returning garbage.
 */

export class CryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CryptoError";
  }
}

function loadKey(): Buffer {
  const raw = getConfig().encryptionKey;
  if (!raw) {
    throw new CryptoError(
      "ENCRYPTION_KEY is not set. Generate one with `openssl rand -hex 32` and add it to the Vercel project settings.",
    );
  }
  const key = /^[0-9a-f]{64}$/i.test(raw)
    ? Buffer.from(raw, "hex")
    : Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new CryptoError(
      "ENCRYPTION_KEY must be 32 bytes: 64 hex characters or a base64 string that decodes to 32 bytes.",
    );
  }
  return key;
}

export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", loadKey(), iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv, tag, body].map((p) => (typeof p === "string" ? p : p.toString("base64url"))).join(".");
}

export function decrypt(payload: string): string {
  const [version, iv, tag, body] = payload.split(".");
  if (version !== "v1" || !iv || !tag || !body) {
    throw new CryptoError("Encrypted value has an unknown format.");
  }
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      loadKey(),
      Buffer.from(iv, "base64url"),
    );
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(body, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch (err) {
    if (err instanceof CryptoError) throw err;
    throw new CryptoError(
      "Could not decrypt the value - ENCRYPTION_KEY changed or the data was altered.",
    );
  }
}

export function encryptJson(value: unknown): string {
  return encrypt(JSON.stringify(value));
}

export function decryptJson<T>(payload: string): T {
  return JSON.parse(decrypt(payload)) as T;
}
