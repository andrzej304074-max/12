import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ProInputError } from "../src/pro/errors.js";
import {
  parseToken,
  signingPayload,
  signRequest,
  verifyWebhookSignature,
} from "../src/pro/signing.js";

/**
 * The signature is the one thing Vinted checks on every request, and nothing
 * here can talk to Vinted, so the algorithm is pinned three ways: known
 * answers computed outside this code base (Python), an independent HMAC in the
 * test, and the structure of the payload.
 */

describe("parseToken", () => {
  it("splits the portal string on its first comma", () => {
    expect(parseToken("ACCESS,SIGNING")).toEqual({ accessKey: "ACCESS", signingKey: "SIGNING" });
    expect(parseToken("  ACCESS , SIGN,ING  ")).toEqual({ accessKey: "ACCESS", signingKey: "SIGN,ING" });
  });

  it.each(["", "ACCESS", ",SIGNING", "ACCESS,", "AC CESS,SIGNING", "ACCESS,SIGN\nING"])("rejects %j", (token) => {
    expect(() => parseToken(token)).toThrow(ProInputError);
  });

  it("never puts the token in the error message", () => {
    try {
      parseToken("secret-without-comma");
    } catch (err) {
      expect((err as Error).message).not.toContain("secret-without-comma");
    }
  });
});

describe("signingPayload", () => {
  it("is five parts joined by dots: t, METHOD, path?query, access key, body", () => {
    expect(signingPayload(1704067200, "post", "/api/v1/items", "ACCESS", '{"a":1}')).toBe(
      '1704067200.POST./api/v1/items.ACCESS.{"a":1}',
    );
  });

  it("keeps an empty body as an empty last part", () => {
    expect(signingPayload(1, "GET", "/api/v1/orders?after-id=5", "K", "")).toBe("1.GET./api/v1/orders?after-id=5.K.");
  });
});

describe("signRequest", () => {
  const creds = { accessKey: "ACCESS", signingKey: "signing-secret" };

  it("matches known answers computed outside this code base", () => {
    const post = signRequest(creds, "POST", "/api/v1/items", '{"items":[]}', 1704067200_000);
    expect(post.headers["X-Vpi-Hmac-Sha256"]).toBe(
      "t=1704067200,v1=b90eab61a388686245809ba7ad8bc6bd9adeecb0e399c071fbd0db8f422cbd2e",
    );
    const get = signRequest(creds, "GET", "/api/v1/orders?after-id=123", "", 1704067200_000);
    expect(get.headers["X-Vpi-Hmac-Sha256"]).toBe(
      "t=1704067200,v1=5006f663d1ace758b4189609c68e7bac8df864e6451c2961082984b2d71b8261",
    );
  });

  it("sends the access key and a signature, and never the signing key", () => {
    const { headers } = signRequest(creds, "GET", "/api/v1/ontologies", "");
    expect(headers["X-Vpi-Access-Key"]).toBe("ACCESS");
    expect(headers["X-Vpi-Hmac-Sha256"]).toMatch(/^t=\d{10},v1=[0-9a-f]{64}$/);
    expect(JSON.stringify(headers)).not.toContain("signing-secret");
  });

  it("uses whole seconds and signs the exact timestamp it sends", () => {
    const { t, headers } = signRequest(creds, "GET", "/p", "", 1_700_000_000_999);
    expect(t).toBe(1_700_000_000);
    const v1 = createHmac("sha256", "signing-secret").update("1700000000.GET./p.ACCESS.").digest("hex");
    expect(headers["X-Vpi-Hmac-Sha256"]).toBe(`t=1700000000,v1=${v1}`);
  });

  it("gives a different signature when any signed part changes", () => {
    const base = signRequest(creds, "POST", "/api/v1/items", "{}", 1000_000).headers["X-Vpi-Hmac-Sha256"];
    expect(signRequest(creds, "PUT", "/api/v1/items", "{}", 1000_000).headers["X-Vpi-Hmac-Sha256"]).not.toBe(base);
    expect(signRequest(creds, "POST", "/api/v1/items?x=1", "{}", 1000_000).headers["X-Vpi-Hmac-Sha256"]).not.toBe(base);
    expect(signRequest(creds, "POST", "/api/v1/items", "{ }", 1000_000).headers["X-Vpi-Hmac-Sha256"]).not.toBe(base);
    expect(signRequest({ ...creds, accessKey: "OTHER" }, "POST", "/api/v1/items", "{}", 1000_000).headers["X-Vpi-Hmac-Sha256"]).not.toBe(base);
    expect(signRequest(creds, "POST", "/api/v1/items", "{}", 1001_000).headers["X-Vpi-Hmac-Sha256"]).not.toBe(base);
  });
});

describe("verifyWebhookSignature", () => {
  const key = "whsec_test";
  const raw = '{"event_type":"ITEM_SOLD","data":{"id":"abc"}}';
  const now = 1704067200_000;
  const header = "t=1704067200,v1=5c2995ecd18cd9c7c92c9cc223b4c4b2d0d165cd3acd77a3301da0059a8f820b";

  it("accepts a delivery signed over the raw body (known answer computed outside this code base)", () => {
    expect(verifyWebhookSignature(header, raw, key, { now })).toEqual({ ok: true, t: 1704067200 });
    expect(verifyWebhookSignature(header, Buffer.from(raw), key, { now })).toEqual({ ok: true, t: 1704067200 });
  });

  it("rejects a wrong key, a changed body and a body re-serialised with other whitespace", () => {
    expect(verifyWebhookSignature(header, raw, "other", { now })).toEqual({ ok: false, reason: "mismatch" });
    expect(verifyWebhookSignature(header, raw.replace("abc", "abd"), key, { now })).toEqual({ ok: false, reason: "mismatch" });
    expect(verifyWebhookSignature(header, JSON.stringify(JSON.parse(raw), null, 1), key, { now })).toEqual({ ok: false, reason: "mismatch" });
  });

  it("refuses an old or a far-future timestamp", () => {
    expect(verifyWebhookSignature(header, raw, key, { now: now + 301_000 })).toEqual({ ok: false, reason: "stale" });
    expect(verifyWebhookSignature(header, raw, key, { now: now - 301_000 })).toEqual({ ok: false, reason: "stale" });
    expect(verifyWebhookSignature(header, raw, key, { now: now + 299_000 }).ok).toBe(true);
  });

  it("reports a missing or malformed header", () => {
    expect(verifyWebhookSignature(undefined, raw, key, { now })).toEqual({ ok: false, reason: "missing" });
    expect(verifyWebhookSignature("", raw, key, { now })).toEqual({ ok: false, reason: "missing" });
    for (const bad of ["garbage", "t=abc,v1=00", "v1=00", "t=1704067200", "t=1704067200,v1="]) {
      expect(verifyWebhookSignature(bad, raw, key, { now })).toEqual({ ok: false, reason: "malformed" });
    }
  });

  it("does not throw on a signature of the wrong length or non-hex", () => {
    expect(verifyWebhookSignature("t=1704067200,v1=abcd", raw, key, { now }).ok).toBe(false);
    expect(verifyWebhookSignature("t=1704067200,v1=" + "z".repeat(64), raw, key, { now }).ok).toBe(false);
  });

  it("accepts any of several v1 values", () => {
    const multi = `t=1704067200,v1=${"0".repeat(64)},v1=5c2995ecd18cd9c7c92c9cc223b4c4b2d0d165cd3acd77a3301da0059a8f820b`;
    expect(verifyWebhookSignature(multi, raw, key, { now }).ok).toBe(true);
  });
});
