import { describe, it, expect, vi, afterEach } from "vitest";
import { encrypt, decrypt } from "../crypto";

describe("crypto", () => {
  it("round-trips plaintext through encrypt/decrypt", () => {
    const ciphertext = encrypt("sk_live_super_secret");
    expect(decrypt(ciphertext)).toBe("sk_live_super_secret");
  });

  it("encrypts the same plaintext to a different ciphertext each time (random IV)", () => {
    const a = encrypt("same-value");
    const b = encrypt("same-value");
    expect(a).not.toBe(b);
    expect(decrypt(a)).toBe("same-value");
    expect(decrypt(b)).toBe("same-value");
  });

  it("produces a hex iv:authTag:ciphertext triple", () => {
    const ciphertext = encrypt("value");
    const parts = ciphertext.split(":");
    expect(parts).toHaveLength(3);
    for (const part of parts) {
      expect(part).toMatch(/^[0-9a-f]+$/);
    }
  });

  it("throws on malformed ciphertext missing a segment", () => {
    expect(() => decrypt("only-one-part")).toThrow("Invalid ciphertext format");
  });

  it("throws on malformed ciphertext missing the final segment", () => {
    expect(() => decrypt("abcd:ef01")).toThrow("Invalid ciphertext format");
  });

  it("fails to decrypt when the auth tag has been tampered with", () => {
    const ciphertext = encrypt("value");
    const [iv, authTag, data] = ciphertext.split(":");
    const tamperedTag = authTag.replace(/^./, authTag[0] === "0" ? "1" : "0");
    expect(() => decrypt(`${iv}:${tamperedTag}:${data}`)).toThrow();
  });

  it("fails to decrypt when the ciphertext bytes have been tampered with", () => {
    const ciphertext = encrypt("value");
    const [iv, authTag, data] = ciphertext.split(":");
    const tamperedData = data.replace(/^./, data[0] === "0" ? "1" : "0");
    expect(() => decrypt(`${iv}:${authTag}:${tamperedData}`)).toThrow();
  });

  // KEY_HEX is read from process.env.ENCRYPTION_KEY once at module load, so
  // exercising "bad key" branches requires a fresh module instance per case
  // (vi.resetModules + dynamic import) rather than mutating process.env
  // against the already-imported module above.
  describe("ENCRYPTION_KEY validation", () => {
    const original = process.env.ENCRYPTION_KEY;

    afterEach(() => {
      process.env.ENCRYPTION_KEY = original;
      vi.resetModules();
    });

    it("throws when ENCRYPTION_KEY is unset", async () => {
      vi.resetModules();
      delete process.env.ENCRYPTION_KEY;
      const fresh = await import("../crypto.js");
      expect(() => fresh.encrypt("value")).toThrow(
        "ENCRYPTION_KEY must be a 64-char hex string (32 bytes)"
      );
    });

    it("throws when ENCRYPTION_KEY is the wrong length", async () => {
      vi.resetModules();
      process.env.ENCRYPTION_KEY = "abc123";
      const fresh = await import("../crypto.js");
      expect(() => fresh.encrypt("value")).toThrow(
        "ENCRYPTION_KEY must be a 64-char hex string (32 bytes)"
      );
    });

    it("decrypt also validates ENCRYPTION_KEY before touching ciphertext", async () => {
      const ciphertext = encrypt("value"); // uses the correctly-keyed top-level module
      vi.resetModules();
      process.env.ENCRYPTION_KEY = "too-short";
      const fresh = await import("../crypto.js");
      expect(() => fresh.decrypt(ciphertext)).toThrow(
        "ENCRYPTION_KEY must be a 64-char hex string (32 bytes)"
      );
    });
  });
});
