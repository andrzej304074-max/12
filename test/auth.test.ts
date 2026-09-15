import { beforeEach, describe, expect, it } from "vitest";
import { checkBearer, safeEqual } from "../src/auth.js";
import { resetConfigCache } from "../src/config.js";

beforeEach(() => {
  delete process.env.VERCEL;
  process.env.NODE_ENV = "test";
  resetConfigCache();
});

describe("safeEqual", () => {
  it("matches identical strings", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
  });

  it("rejects different strings of equal length", () => {
    expect(safeEqual("abc", "abd")).toBe(false);
  });

  it("rejects strings of different length", () => {
    expect(safeEqual("abc", "abcd")).toBe(false);
  });
});

describe("checkBearer", () => {
  it("accepts a correct token", () => {
    expect(checkBearer("Bearer secret", "secret")).toEqual({ ok: true });
  });

  it("rejects a wrong token with 403", () => {
    expect(checkBearer("Bearer nope", "secret")).toMatchObject({
      ok: false,
      status: 403,
    });
  });

  it("rejects a missing header with 401", () => {
    expect(checkBearer(undefined, "secret")).toMatchObject({
      ok: false,
      status: 401,
    });
  });

  it("rejects a header that is not a bearer scheme", () => {
    expect(checkBearer("Basic abc", "secret")).toMatchObject({
      ok: false,
      status: 401,
    });
  });

  it("allows an unsecured endpoint outside production", () => {
    expect(checkBearer(undefined, null)).toEqual({ ok: true });
  });

  it("refuses to serve an unsecured endpoint in production", () => {
    process.env.VERCEL = "1";
    resetConfigCache();
    expect(checkBearer(undefined, null)).toMatchObject({
      ok: false,
      status: 500,
    });
  });
});
