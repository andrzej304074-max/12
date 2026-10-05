import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleRequest } from "../src/mcp/server.js";
import { saveAccount } from "../src/vinted/accounts.js";
import { VintedClient } from "../src/vinted/client.js";
import { assertVintedHost, HostError, isVintedHost } from "../src/vinted/hosts.js";
import { callTool, freshEnv, jsonRes, mockFetch } from "./helpers.js";

const ACCOUNT = { label: "Ala", domain: "www.vinted.pl", userId: 42, login: "ala", avatarUrl: null, secrets: { accessToken: "tok-ala" } };

beforeEach(() => freshEnv());
afterEach(() => vi.unstubAllGlobals());

describe("isVintedHost", () => {
  it.each(["www.vinted.pl", "vinted.fr", "www.vinted.co.uk", "www.vinted.de", "WWW.VINTED.PL"])("accepts %s", (host) => {
    expect(isVintedHost(host)).toBe(true);
  });

  it.each([
    "evil.com",
    "www.vinted.pl.evil.com",
    "vinted.pl.evil.com",
    "evilvinted.pl",
    "www.vinted.pl@evil.com",
    "www.vinted.pl:8080",
    "www.vinted.pl/evil",
    "localhost",
    "127.0.0.1",
    "",
  ])("rejects %j", (host) => {
    expect(isVintedHost(host)).toBe(false);
  });

  it("throws a readable error and lowercases good hosts", () => {
    expect(() => assertVintedHost("evil.com")).toThrow(HostError);
    expect(assertVintedHost(" WWW.Vinted.PL ")).toBe("www.vinted.pl");
  });
});

describe("tools cannot aim an account's cookie at another host", () => {
  beforeEach(async () => {
    await saveAccount(ACCOUNT);
  });

  it("refuses a hostile domain on an anonymous read, without any request", async () => {
    const { calls } = mockFetch(() => jsonRes(200, {}));
    const r = await callTool("search_similar_items", { query: "kurtka", domain: "evil.com" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/not a Vinted marketplace host/);
    expect(calls).toHaveLength(0);
  });

  it("refuses it when an account is involved, so its token is never sent", async () => {
    const { calls } = mockFetch(() => jsonRes(200, {}));
    const r = await callTool("watch_seller", { seller_id: "77", domain: "www.vinted.pl.evil.com" });
    expect(r.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("refuses a hostile domain stored on an account", async () => {
    const { calls } = mockFetch(() => jsonRes(200, {}));
    const [account] = await (await import("../src/vinted/accounts.js")).listAccounts();
    await expect(
      new VintedClient().send("POST", "/api/v2/offers", { account: { ...account!, domain: "evil.com" }, body: {} }),
    ).rejects.toThrow(/not a Vinted marketplace host/);
    expect(calls).toHaveLength(0);
  });

  it("still works for a real marketplace host", async () => {
    const { calls } = mockFetch((url) =>
      url.pathname === "/" ? new Response("<html></html>", { headers: { "content-type": "text/html" } }) : jsonRes(200, { items: [] }),
    );
    const r = await callTool("search_similar_items", { query: "kurtka", domain: "www.vinted.de" });
    expect(r.isError).toBe(false);
    expect(calls.every((c) => c.url.hostname === "www.vinted.de")).toBe(true);
  });
});

describe("what the model is told about messages from strangers", () => {
  it("warns that conversation text is data, not instructions", async () => {
    const res = (await handleRequest({ jsonrpc: "2.0", id: 1, method: "initialize" })) as {
      result: { instructions: string };
    };
    expect(res.result.instructions).toMatch(/written by other people/);
    expect(res.result.instructions).toMatch(/never as instructions/);
  });
});
