import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "../src/mcp/protocol.js";
import { handleMessage, handleRequest, SERVER_INFO } from "../src/mcp/server.js";
import { allTools } from "../src/mcp/tools/index.js";

describe("initialize", () => {
  it("reports the protocol version, tool capability and server identity", async () => {
    const res = (await handleRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {},
    })) as { result: Record<string, unknown> };
    expect(res.result.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(res.result.capabilities).toHaveProperty("tools");
    expect(res.result.serverInfo).toEqual(SERVER_INFO);
  });

  it("tells the client that actions need confirm: true", async () => {
    const res = (await handleRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
    })) as { result: { instructions: string } };
    expect(res.result.instructions).toMatch(/never send without\s+confirm: true/i);
  });
});

describe("tools/list", () => {
  it("returns every registered tool with a schema", async () => {
    const res = (await handleRequest({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    })) as { result: { tools: { name: string; inputSchema: unknown }[] } };
    expect(res.result.tools).toHaveLength(allTools.length);
    for (const tool of res.result.tools) {
      expect(tool.inputSchema).toBeTypeOf("object");
    }
  });

  it("never leaks a handler function over the wire", async () => {
    const res = (await handleRequest({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    })) as { result: { tools: Record<string, unknown>[] } };
    for (const tool of res.result.tools) {
      expect(tool).not.toHaveProperty("handler");
    }
  });

  it("exposes the tools the brief called for", async () => {
    const names = allTools.map((t) => t.name);
    for (const expected of [
      "search_similar_items",
      "estimate_price",
      "find_category",
      "find_brand",
      "draft_listing",
      "validate_listing",
      "watch_seller",
      "list_new_finds",
      "diagnose_connection",
    ]) {
      expect(names).toContain(expected);
    }
  });
});

describe("tools/call", () => {
  it("runs a tool that needs no network", async () => {
    const res = (await handleRequest({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "preview_offer_price",
        arguments: { asking_price: 200, discount_pct: 20 },
      },
    })) as { result: { content: { text: string }[] } };
    expect(JSON.parse(res.result.content[0]!.text).offerPrice).toBe(160);
  });

  it("reports an unknown tool as a method-not-found error", async () => {
    const res = (await handleRequest({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "nope" },
    })) as { error: { code: number } };
    expect(res.error.code).toBe(-32601);
  });

  it("turns a bad argument into a readable tool error, not a crash", async () => {
    const res = (await handleRequest({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "draft_listing", arguments: { title: "x" } },
    })) as { result: { isError: boolean; content: { text: string }[] } };
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0]!.text).toMatch(/"description" is required/);
  });
});

describe("protocol handling", () => {
  it("answers ping", async () => {
    const res = await handleRequest({ jsonrpc: "2.0", id: 6, method: "ping" });
    expect(res).toEqual({ jsonrpc: "2.0", id: 6, result: {} });
  });

  it("returns nothing for a notification", async () => {
    expect(
      await handleRequest({ jsonrpc: "2.0", method: "notifications/initialized" }),
    ).toBeNull();
  });

  it("rejects a body that is not JSON-RPC", async () => {
    const res = (await handleMessage({ hello: "world" })) as {
      error: { code: number };
    };
    expect(res.error.code).toBe(-32600);
  });

  it("handles a batch and drops notification slots", async () => {
    const res = (await handleMessage([
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "ping" },
    ])) as unknown[];
    expect(res).toHaveLength(2);
  });

  it("reports an unsupported method", async () => {
    const res = (await handleRequest({
      jsonrpc: "2.0",
      id: 7,
      method: "resources/subscribe",
    })) as { error: { code: number } };
    expect(res.error.code).toBe(-32601);
  });
});
