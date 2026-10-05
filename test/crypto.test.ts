import { beforeEach, describe, expect, it } from "vitest";
import { CryptoError, decrypt, decryptJson, encrypt, encryptJson } from "../src/crypto.js";
import { resetConfigCache } from "../src/config.js";
import { freshEnv, TEST_KEY } from "./helpers.js";

beforeEach(() => freshEnv());

describe("encryption", () => {
  it("round-trips text", () => {
    expect(decrypt(encrypt("access-token-123"))).toBe("access-token-123");
  });

  it("round-trips JSON", () => {
    expect(decryptJson(encryptJson({ a: 1, b: ["x"] }))).toEqual({ a: 1, b: ["x"] });
  });

  it("does not contain the plaintext", () => {
    expect(encrypt("super-secret-token")).not.toContain("super-secret-token");
  });

  it("uses a fresh IV, so equal inputs give different ciphertexts", () => {
    expect(encrypt("same")).not.toBe(encrypt("same"));
  });

  it("rejects a tampered ciphertext", () => {
    const parts = encrypt("hello").split(".");
    parts[3] = Buffer.from("tampered").toString("base64url");
    expect(() => decrypt(parts.join("."))).toThrow(CryptoError);
  });

  it("cannot be decrypted with a different key", () => {
    const sealed = encrypt("hello");
    process.env.ENCRYPTION_KEY = "cd".repeat(32);
    resetConfigCache();
    expect(() => decrypt(sealed)).toThrow(/ENCRYPTION_KEY changed/);
  });

  it("refuses to work without a key", () => {
    delete process.env.ENCRYPTION_KEY;
    resetConfigCache();
    expect(() => encrypt("x")).toThrow(/ENCRYPTION_KEY is not set/);
  });

  it("rejects a key of the wrong length", () => {
    process.env.ENCRYPTION_KEY = "abcd";
    resetConfigCache();
    expect(() => encrypt("x")).toThrow(/32 bytes/);
  });

  it("accepts a base64 key", () => {
    process.env.ENCRYPTION_KEY = Buffer.from(TEST_KEY, "hex").toString("base64");
    resetConfigCache();
    expect(decrypt(encrypt("ok"))).toBe("ok");
  });

  it("rejects an unknown format", () => {
    expect(() => decrypt("garbage")).toThrow(/unknown format/);
  });
});
