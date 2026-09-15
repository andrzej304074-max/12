import { describe, expect, it } from "vitest";
import { redact } from "../src/log.js";

describe("redact", () => {
  it("hides an access token", () => {
    expect(redact({ accessToken: "secret-value" })).toEqual({
      accessToken: "[redacted]",
    });
  });

  it("hides secrets nested inside objects and arrays", () => {
    const out = redact({
      accounts: [{ id: "main", access_token: "s3cr3t", cookie: "c" }],
    }) as { accounts: { id: string; access_token: string; cookie: string }[] };
    expect(out.accounts[0]!.id).toBe("main");
    expect(out.accounts[0]!.access_token).toBe("[redacted]");
    expect(out.accounts[0]!.cookie).toBe("[redacted]");
  });

  it("matches secret keys case-insensitively", () => {
    expect(redact({ Authorization: "Bearer x" })).toEqual({
      Authorization: "[redacted]",
    });
  });

  it("leaves ordinary values alone", () => {
    expect(redact({ sellerId: "123", count: 4 })).toEqual({
      sellerId: "123",
      count: 4,
    });
  });

  it("stops runaway recursion", () => {
    const deep: Record<string, unknown> = {};
    let cursor = deep;
    for (let i = 0; i < 20; i++) {
      const next: Record<string, unknown> = {};
      cursor.next = next;
      cursor = next;
    }
    expect(JSON.stringify(redact(deep))).toContain("truncated");
  });
});
