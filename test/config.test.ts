import { beforeEach, describe, expect, it } from "vitest";
import { getConfig, parseAccounts, resetConfigCache } from "../src/config.js";
import { freshEnv } from "./helpers.js";

describe("Upstash credentials", () => {
  beforeEach(() => {
    freshEnv();
    for (const key of ["KV_REST_API_URL", "KV_REST_API_TOKEN"]) delete process.env[key];
    resetConfigCache();
  });

  it("is off when nothing is set", () => {
    expect(getConfig().upstash).toBeNull();
  });

  it("reads the UPSTASH_* names", () => {
    process.env.UPSTASH_REDIS_REST_URL = "https://a.upstash.io/";
    process.env.UPSTASH_REDIS_REST_TOKEN = "tok-a";
    expect(getConfig().upstash).toEqual({ url: "https://a.upstash.io", token: "tok-a" });
  });

  it("falls back to the KV_REST_API_* names the Vercel integration sets", () => {
    process.env.KV_REST_API_URL = "https://kv.upstash.io";
    process.env.KV_REST_API_TOKEN = "tok-kv";
    expect(getConfig().upstash).toEqual({ url: "https://kv.upstash.io", token: "tok-kv" });
  });

  it("prefers the UPSTASH_* names when both exist", () => {
    process.env.UPSTASH_REDIS_REST_URL = "https://a.upstash.io";
    process.env.UPSTASH_REDIS_REST_TOKEN = "tok-a";
    process.env.KV_REST_API_URL = "https://kv.upstash.io";
    process.env.KV_REST_API_TOKEN = "tok-kv";
    expect(getConfig().upstash?.url).toBe("https://a.upstash.io");
  });

  it("needs both the URL and the token", () => {
    process.env.KV_REST_API_URL = "https://kv.upstash.io";
    expect(getConfig().upstash).toBeNull();
  });
});

describe("parseAccounts", () => {
  it("returns nothing when unset", () => {
    expect(parseAccounts(null)).toEqual([]);
  });

  it("parses a well-formed account", () => {
    const accounts = parseAccounts(
      JSON.stringify([
        { id: "main", label: "Main shop", accessToken: "tok", userId: 42 },
      ]),
    );
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({
      id: "main",
      label: "Main shop",
      accessToken: "tok",
      userId: 42,
    });
  });

  it("falls back to the id when no label is given", () => {
    const [account] = parseAccounts(
      JSON.stringify([{ id: "main", accessToken: "tok" }]),
    );
    expect(account!.label).toBe("main");
  });

  it("rejects malformed JSON loudly rather than yielding nothing", () => {
    expect(() => parseAccounts("{not json")).toThrow(/not valid JSON/);
  });

  it("rejects a non-array value", () => {
    expect(() => parseAccounts('{"id":"main"}')).toThrow(/must be a JSON array/);
  });

  it("names the index of an entry missing its id", () => {
    expect(() => parseAccounts('[{"accessToken":"tok"}]')).toThrow(
      /VINTED_ACCOUNTS\[0\]\.id is required/,
    );
  });

  it("names the index of an entry missing its token", () => {
    expect(() => parseAccounts('[{"id":"main"}]')).toThrow(
      /VINTED_ACCOUNTS\[0\]\.accessToken is required/,
    );
  });
});
