import { describe, expect, it } from "vitest";
import { handleMessage, handleRequest } from "../src/mcp/server.js";
import { activeTools, allTools, findTool, officialTools, toolManifest, unofficialTools } from "../src/mcp/tools/index.js";
import { callTool, freshEnv } from "./helpers.js";

/**
 * The tools built on Vinted's unofficial consumer API are hidden unless
 * ENABLE_UNOFFICIAL=true. The official Pro tools are always there.
 */

const UNOFFICIAL_SAMPLE = ["like_item", "make_offer", "watch_seller", "list_conversations", "search_similar_items", "upload_photo", "diagnose_connection"];

describe("by default", () => {
  it("shows only the official tools", async () => {
    freshEnv({ ENABLE_UNOFFICIAL: undefined });
    const names = toolManifest().map((t) => t.name);
    expect(names).toEqual(officialTools.map((t) => t.name));
    expect(names.every((n) => n === "diagnose_pro" || n.startsWith("pro_"))).toBe(true);
    for (const hidden of UNOFFICIAL_SAMPLE) expect(names).not.toContain(hidden);
    expect(activeTools()).toHaveLength(officialTools.length);
  });

  it("cannot call a hidden tool, even by name", async () => {
    freshEnv({ ENABLE_UNOFFICIAL: undefined });
    for (const name of UNOFFICIAL_SAMPLE) expect(findTool(name)).toBeUndefined();
    const res = (await handleRequest({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "like_item", arguments: { item_id: "1", confirm: true } } })) as { error?: { code: number; message: string } };
    expect(res.error?.code).toBe(-32601);
  });

  it("tells a client what this server is, without promising likes and offers", async () => {
    freshEnv({ ENABLE_UNOFFICIAL: undefined });
    const res = (await handleRequest({ jsonrpc: "2.0", id: 1, method: "initialize" })) as { result: { instructions: string } };
    expect(res.result.instructions).toMatch(/official Vinted Pro Integrations API/);
    expect(res.result.instructions).toMatch(/never sends without confirm: true/);
    expect(res.result.instructions).not.toMatch(/like_item|make_offer|watch/i);
  });

  it("still lists the official tools over the protocol", async () => {
    freshEnv({ ENABLE_UNOFFICIAL: undefined });
    const res = (await handleMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" })) as { result: { tools: { name: string }[] } };
    expect(res.result.tools.length).toBe(officialTools.length);
  });
});

describe("with ENABLE_UNOFFICIAL=true", () => {
  it("shows both sets", async () => {
    freshEnv({ ENABLE_UNOFFICIAL: "true" });
    expect(activeTools()).toHaveLength(allTools.length);
    expect(allTools).toHaveLength(officialTools.length + unofficialTools.length);
    for (const name of UNOFFICIAL_SAMPLE) expect(findTool(name)).toBeDefined();
    const res = (await handleRequest({ jsonrpc: "2.0", id: 1, method: "initialize" })) as { result: { instructions: string } };
    expect(res.result.instructions).toMatch(/official Vinted Pro/);
    expect(res.result.instructions).toMatch(/never send without\s+confirm: true/);
  });

  it("does not change what an official tool does", async () => {
    freshEnv({ ENABLE_UNOFFICIAL: "true" });
    const { isError, text } = await callTool("diagnose_pro");
    expect(isError).toBe(true);
    expect(text).toMatch(/Konta/);
  });

  it("keeps tool names unique across both sets", () => {
    const names = allTools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
