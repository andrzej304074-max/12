import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetConfigCache } from "../src/config.js";
import { handleRequest } from "../src/mcp/server.js";
import { getAutopause, setLimits } from "../src/monitor/safety.js";
import { resetStoreCache } from "../src/store/index.js";
import { resetClientCache } from "../src/vinted/client.js";

/**
 * Write actions against a stubbed fetch. Nothing here reaches the network.
 */

const fetchMock = vi.fn<(input: URL | string, init?: RequestInit) => Promise<Response>>();

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

async function call(name: string, args: Record<string, unknown>) {
  const res = (await handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  })) as { result: { isError?: boolean; content: { text: string }[] } };
  const text = res.result.content[0]!.text;
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  return { isError: res.result.isError ?? false, text, body: parsed };
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  delete process.env.VERCEL;
  process.env.VINTED_ACCOUNTS = JSON.stringify([{ id: "main", accessToken: "tok" }]);
  process.env.VINTED_MIN_REQUEST_INTERVAL_MS = "0";
  process.env.ACTIVE_HOURS = "0-0";
  resetConfigCache();
  resetStoreCache();
  resetClientCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("confirm gate", () => {
  it("returns a preview and sends nothing without confirm", async () => {
    const { body } = await call("make_offer", { item_id: "42", price: 80 });
    expect(body).toMatchObject({ preview: true, sent: false, allowedNow: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("treats confirm: false like no confirm", async () => {
    await call("like_item", { item_id: "42", confirm: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends the offer with confirm: true", async () => {
    fetchMock.mockResolvedValue(json(200, { offer: { id: 1 } }));
    const { body } = await call("make_offer", { item_id: "42", price: 80, confirm: true });
    expect(body).toMatchObject({ sent: true, price: 80 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/api/v2/offers");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toMatchObject({ item_id: 42, price: "80.00" });
  });

  it("sends the account's token, never an anonymous write", async () => {
    fetchMock.mockResolvedValue(json(200, {}));
    await call("like_item", { item_id: "42", confirm: true });
    const headers = fetchMock.mock.calls[0]![1]!.headers as Record<string, string>;
    expect(headers.cookie).toContain("access_token_web=tok");
  });
});

describe("limits on confirmed actions", () => {
  it("refuses the offer past the daily limit, without sending", async () => {
    await setLimits("main", { offersPerDay: 1 });
    fetchMock.mockResolvedValue(json(200, {}));
    await call("make_offer", { item_id: "1", price: 10, confirm: true });
    const second = await call("make_offer", { item_id: "2", price: 10, confirm: true });
    expect(second.isError).toBe(true);
    expect(second.text).toMatch(/Daily offer limit of 1/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("shows in the preview when the limit is already used up", async () => {
    await setLimits("main", { likesPerDay: 0 });
    const { body } = await call("like_item", { item_id: "1" });
    expect(body).toMatchObject({ allowedNow: false });
  });

  it("is adjustable through set_automation_limits", async () => {
    const { body } = await call("set_automation_limits", {
      offers_per_day: 50,
      active_hours: "9-21",
    });
    expect(body).toMatchObject({
      limits: { offersPerDay: 50, activeHours: { start: 9, end: 21 } },
    });
    const status = await call("get_automation_status", {});
    expect(status.body).toMatchObject({
      limitSource: { offersPerDay: "set at runtime", likesPerDay: "environment" },
    });
  });

  it("rejects a bad limit value", async () => {
    const res = await call("set_automation_limits", { offers_per_day: -3 });
    expect(res.isError).toBe(true);
  });
});

describe("write failures", () => {
  it("does not retry a 5xx, so an offer is never sent twice", async () => {
    fetchMock.mockResolvedValue(json(503, { error: "down" }));
    const res = await call("make_offer", { item_id: "42", price: 80, confirm: true });
    expect(res.isError).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("trips the circuit breaker on a 403", async () => {
    fetchMock.mockResolvedValue(json(403, {}));
    const res = await call("like_item", { item_id: "42", confirm: true });
    expect(res.isError).toBe(true);
    expect(await getAutopause("main")).not.toBeNull();
  });

  it("treats an HTML page instead of JSON as a refusal", async () => {
    fetchMock.mockResolvedValue(
      new Response("<html>captcha</html>", { status: 200, headers: { "content-type": "text/html" } }),
    );
    await call("like_item", { item_id: "42", confirm: true });
    expect(await getAutopause("main")).not.toBeNull();
  });

  it("does not count a failed action against the limit", async () => {
    await setLimits("main", { offersPerDay: 1 });
    fetchMock.mockResolvedValueOnce(json(500, {}));
    await call("make_offer", { item_id: "1", price: 10, confirm: true });
    fetchMock.mockResolvedValueOnce(json(200, {}));
    const second = await call("make_offer", { item_id: "2", price: 10, confirm: true });
    expect(second.body).toMatchObject({ sent: true });
  });
});

describe("publish_listing", () => {
  const base = {
    title: "Kurtka Zara M",
    description: "Kurtka w bardzo dobrym stanie, bez wad, noszona jeden sezon.",
    price: 120,
    catalog_id: 1234,
    condition: "very good",
    size: "M",
    photo_ids: [1, 2, 3],
  };

  it("refuses a draft with blockers, without sending", async () => {
    const { body } = await call("publish_listing", { ...base, photo_ids: [], confirm: true });
    expect(body).toMatchObject({ sent: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("publishes a valid draft with confirm", async () => {
    fetchMock.mockResolvedValue(json(200, { item: { id: 9 } }));
    const { body } = await call("publish_listing", { ...base, confirm: true });
    expect(body).toMatchObject({ sent: true });
    const sent = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body));
    expect(sent.item).toMatchObject({ title: base.title, catalog_id: 1234 });
  });
});

describe("send_message", () => {
  it("opens the conversation then posts the message", async () => {
    fetchMock
      .mockResolvedValueOnce(json(200, { conversation: { id: 77 } }))
      .mockResolvedValueOnce(json(200, {}));
    const { body } = await call("send_message", {
      item_id: "42",
      text: "Dzien dobry, czy aktualne?",
      confirm: true,
    });
    expect(body).toMatchObject({ sent: true });
    expect(String(fetchMock.mock.calls[1]![0])).toContain("/conversations/77/messages");
  });
});
