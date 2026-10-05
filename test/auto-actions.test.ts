import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetConfigCache } from "../src/config.js";
import { resetStoreCache } from "../src/store/index.js";
import { resetClientCache } from "../src/vinted/client.js";
import type { NormalisedItem } from "../src/vinted/types.js";

/**
 * The cron path with automatic actions. Seller reads are mocked at the module
 * boundary; writes go through a stubbed fetch.
 */

const getSellerItems = vi.fn<(...args: unknown[]) => Promise<NormalisedItem[]>>();

vi.mock("../src/vinted/search.js", () => ({
  getSellerItems: (...args: unknown[]) => getSellerItems(...args),
  getSeller: vi.fn(async () => null),
  searchItems: vi.fn(async () => []),
  getItem: vi.fn(async () => null),
  suggest: vi.fn(async () => []),
  getCatalogs: vi.fn(async () => []),
  findCatalogPath: vi.fn(() => []),
}));

const { addWatch, listFinds, runPassForAccount, seedWatch } = await import(
  "../src/monitor/engine.js"
);
const { localHour, setLimits, tripBreaker } = await import("../src/monitor/safety.js");

const fetchMock = vi.fn<(input: URL | string, init?: RequestInit) => Promise<Response>>();
const ok = () =>
  new Response("{}", { status: 200, headers: { "content-type": "application/json" } });

const account = { id: "main", label: "Main", accessToken: "tok" };

function item(id: string, price = 100): NormalisedItem {
  return {
    id,
    title: `item ${id}`,
    price,
    currency: "PLN",
    brand: null,
    size: null,
    condition: null,
    url: `https://www.vinted.pl/items/${id}`,
    favourites: null,
    sellerId: "777",
    sellerLogin: "seller",
    photoUrl: null,
    createdAt: null,
  };
}

async function watchWith(flags: { autoLike?: boolean; autoOffer?: boolean }) {
  await addWatch("main", {
    sellerId: "777",
    sellerLogin: "seller",
    addedAt: new Date().toISOString(),
    domain: null,
    discountPct: null,
    ...flags,
  });
  await seedWatch("main", "777", []);
}

const writes = () =>
  fetchMock.mock.calls.filter(([, init]) => init?.method && init.method !== "GET");

beforeEach(() => {
  getSellerItems.mockReset();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => ok());
  vi.stubGlobal("fetch", fetchMock);
  delete process.env.VERCEL;
  delete process.env.NOTIFY_WEBHOOK_URL;
  process.env.VINTED_ACCOUNTS = JSON.stringify([account]);
  process.env.VINTED_MIN_REQUEST_INTERVAL_MS = "0";
  process.env.ACTIVE_HOURS = "0-0";
  process.env.AUTO_ACTIONS_ENABLED = "true";
  resetConfigCache();
  resetStoreCache();
  resetClientCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("automatic actions", () => {
  it("sends the 20% offer and the like on a new item", async () => {
    await watchWith({ autoLike: true, autoOffer: true });
    getSellerItems.mockResolvedValue([item("5", 100)]);

    const result = await runPassForAccount(account);
    expect(result.autoActions.map((a) => [a.kind, a.ok])).toEqual([
      ["like", true],
      ["offer", true],
    ]);
    const offer = writes().find(([url]) => String(url).includes("/api/v2/offers"))!;
    expect(JSON.parse(String(offer[1]!.body))).toMatchObject({ item_id: 5, price: "80.00" });
  });

  it("marks the find handled once its actions went out", async () => {
    await watchWith({ autoOffer: true });
    getSellerItems.mockResolvedValue([item("5")]);
    await runPassForAccount(account);
    expect(await listFinds("main")).toHaveLength(0);
    expect((await listFinds("main", { includeHandled: true }))[0]!.autoActions).toHaveLength(1);
  });

  it("sends nothing when AUTO_ACTIONS_ENABLED is not true", async () => {
    process.env.AUTO_ACTIONS_ENABLED = "false";
    resetConfigCache();
    await watchWith({ autoLike: true, autoOffer: true });
    getSellerItems.mockResolvedValue([item("5")]);

    const result = await runPassForAccount(account);
    expect(result.newFinds).toHaveLength(1);
    expect(writes()).toHaveLength(0);
  });

  it("sends nothing for a watch without auto flags", async () => {
    await watchWith({});
    getSellerItems.mockResolvedValue([item("5")]);
    await runPassForAccount(account);
    expect(writes()).toHaveLength(0);
  });

  it("queues actions outside the activity window and sends them later", async () => {
    const hour = localHour();
    await setLimits("main", { activeHours: { start: (hour + 1) % 24, end: (hour + 2) % 24 } });
    await watchWith({ autoOffer: true });
    getSellerItems.mockResolvedValue([item("5")]);

    const first = await runPassForAccount(account);
    expect(writes()).toHaveLength(0);
    expect(first.autoStoppedBecause).toMatch(/activity window/);

    await setLimits("main", { activeHours: { start: 0, end: 0 } });
    const second = await runPassForAccount(account);
    expect(second.autoActions).toEqual([
      expect.objectContaining({ itemId: "5", kind: "offer", ok: true }),
    ]);
  });

  it("spreads actions over hours via the hourly limit", async () => {
    await setLimits("main", { actionsPerHour: 2 });
    await watchWith({ autoOffer: true });
    getSellerItems.mockResolvedValue([item("1"), item("2"), item("3")]);

    const result = await runPassForAccount(account);
    expect(result.autoActions).toHaveLength(2);
    expect(result.autoStoppedBecause).toMatch(/Hourly limit/);
    const pending = (await listFinds("main")).filter((f) => f.autoPending?.length);
    expect(pending).toHaveLength(1);
  });

  it("sends nothing while the circuit breaker is tripped", async () => {
    await tripBreaker("main", "captcha");
    await watchWith({ autoOffer: true });
    getSellerItems.mockResolvedValue([item("5")]);
    const result = await runPassForAccount(account);
    expect(writes()).toHaveLength(0);
    expect(result.autoStoppedBecause).toMatch(/paused/);
  });

  it("stops the queue and pauses when Vinted refuses", async () => {
    fetchMock.mockImplementation(
      async () => new Response("{}", { status: 403, headers: { "content-type": "application/json" } }),
    );
    await watchWith({ autoOffer: true });
    getSellerItems.mockResolvedValue([item("1"), item("2")]);

    const result = await runPassForAccount(account);
    expect(writes()).toHaveLength(1);
    expect(result.autoStoppedBecause).toMatch(/refused/);
  });

  it("does not retry an action whose outcome is unknown", async () => {
    fetchMock.mockImplementationOnce(
      async () => new Response("{}", { status: 500, headers: { "content-type": "application/json" } }),
    );
    await watchWith({ autoOffer: true });
    getSellerItems.mockResolvedValue([item("5")]);
    await runPassForAccount(account);
    await runPassForAccount(account);
    expect(writes()).toHaveLength(1);
  });
});

describe("notifications", () => {
  it("posts new finds to the webhook", async () => {
    process.env.NOTIFY_WEBHOOK_URL = "https://hooks.example.test/x";
    resetConfigCache();
    await watchWith({});
    getSellerItems.mockResolvedValue([item("5", 100)]);

    const result = await runPassForAccount(account);
    expect(result.notified).toBe(true);
    const hook = fetchMock.mock.calls.find(([url]) => String(url).includes("hooks.example.test"))!;
    expect(JSON.parse(String(hook[1]!.body)).content).toContain("oferta 80");
  });

  it("keeps the pass going when the webhook fails", async () => {
    process.env.NOTIFY_WEBHOOK_URL = "https://hooks.example.test/x";
    resetConfigCache();
    fetchMock.mockImplementation(async () => {
      throw new Error("webhook down");
    });
    await watchWith({});
    getSellerItems.mockResolvedValue([item("5")]);
    const result = await runPassForAccount(account);
    expect(result.newFinds).toHaveLength(1);
    expect(result.notified).toBe(false);
  });
});
