import { describe, expect, it } from "vitest";
import { parseAccounts } from "../src/config.js";

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
