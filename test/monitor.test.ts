import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetConfigCache } from "../src/config.js";
import { resetStoreCache } from "../src/store/index.js";
import type { NormalisedItem } from "../src/vinted/types.js";

const getSellerItems = vi.fn<(...args: unknown[]) => Promise<NormalisedItem[]>>();

vi.mock("../src/vinted/search.js", () => ({
  getSellerItems: (...args: unknown[]) => getSellerItems(...args),
  getSeller: vi.fn(async () => ({ id: 1, login: "seller" })),
  searchItems: vi.fn(async () => []),
  getItem: vi.fn(async () => null),
  suggest: vi.fn(async () => []),
  getCatalogs: vi.fn(async () => []),
  findCatalogPath: vi.fn(() => []),
}));

const {
  addWatch,
  listFinds,
  listWatches,
  markFindHandled,
  removeWatch,
  runPassForAccount,
  seedWatch,
} = await import("../src/monitor/engine.js");

function item(id: string, price: number | null = 100): NormalisedItem {
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

const account = {
  id: "main",
  label: "Main",
  accessToken: "tok",
};

beforeEach(() => {
  getSellerItems.mockReset();
  process.env.VINTED_ACCOUNTS = JSON.stringify([account]);
  delete process.env.VERCEL;
  resetConfigCache();
  resetStoreCache();
});

describe("watchlist", () => {
  it("stores and lists a watch", async () => {
    await addWatch("main", {
      sellerId: "777",
      sellerLogin: "seller",
      addedAt: new Date().toISOString(),
      domain: null,
      discountPct: null,
    });
    const watches = await listWatches("main");
    expect(watches).toHaveLength(1);
    expect(watches[0]!.sellerId).toBe("777");
  });

  it("forgets a watch once removed", async () => {
    await addWatch("main", {
      sellerId: "777",
      sellerLogin: null,
      addedAt: "now",
      domain: null,
      discountPct: null,
    });
    await removeWatch("main", "777");
    expect(await listWatches("main")).toEqual([]);
  });
});

describe("runPassForAccount", () => {
  async function watch(discountPct: number | null = null) {
    await addWatch("main", {
      sellerId: "777",
      sellerLogin: "seller",
      addedAt: new Date().toISOString(),
      domain: null,
      discountPct,
    });
  }

  it("reports a newly posted item as a find", async () => {
    await watch();
    await seedWatch("main", "777", [item("1")]);
    getSellerItems.mockResolvedValue([item("2", 250), item("1")]);

    const result = await runPassForAccount(account);
    expect(result.sellersChecked).toBe(1);
    expect(result.newFinds).toHaveLength(1);
    expect(result.newFinds[0]!.itemId).toBe("2");
  });

  it("attaches a 20 percent negotiation price to a find", async () => {
    await watch();
    await seedWatch("main", "777", []);
    getSellerItems.mockResolvedValue([item("2", 250)]);

    const [find] = (await runPassForAccount(account)).newFinds;
    expect(find!.askingPrice).toBe(250);
    expect(find!.discountPct).toBe(20);
    expect(find!.suggestedOfferPrice).toBe(200);
  });

  it("honours a per-seller discount override", async () => {
    await watch(35);
    await seedWatch("main", "777", []);
    getSellerItems.mockResolvedValue([item("2", 200)]);

    const [find] = (await runPassForAccount(account)).newFinds;
    expect(find!.discountPct).toBe(35);
    expect(find!.suggestedOfferPrice).toBe(130);
  });

  it("does not report the same item twice across passes", async () => {
    await watch();
    await seedWatch("main", "777", []);
    getSellerItems.mockResolvedValue([item("2")]);

    expect((await runPassForAccount(account)).newFinds).toHaveLength(1);
    expect((await runPassForAccount(account)).newFinds).toHaveLength(0);
  });

  it("reports nothing when the seller has posted nothing new", async () => {
    await watch();
    await seedWatch("main", "777", [item("1")]);
    getSellerItems.mockResolvedValue([item("1")]);

    expect((await runPassForAccount(account)).newFinds).toEqual([]);
  });

  it("records a failing seller without aborting the pass", async () => {
    await watch();
    getSellerItems.mockRejectedValue(new Error("upstream 503"));

    const result = await runPassForAccount(account);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.message).toContain("503");
    expect(result.newFinds).toEqual([]);
  });

  it("never contacts the seller - only the read path is exercised", async () => {
    await watch();
    await seedWatch("main", "777", []);
    getSellerItems.mockResolvedValue([item("2")]);
    await runPassForAccount(account);
    // getSellerItems is the sole outbound call the engine makes.
    expect(getSellerItems).toHaveBeenCalledTimes(1);
  });
});

describe("finds queue", () => {
  it("hides a find once it is marked handled", async () => {
    await addWatch("main", {
      sellerId: "777",
      sellerLogin: null,
      addedAt: "now",
      domain: null,
      discountPct: null,
    });
    await seedWatch("main", "777", []);
    getSellerItems.mockResolvedValue([item("9")]);
    await runPassForAccount(account);

    expect(await listFinds("main")).toHaveLength(1);
    await markFindHandled("main", "9", "liked it by hand");
    expect(await listFinds("main")).toHaveLength(0);
    expect(await listFinds("main", { includeHandled: true })).toHaveLength(1);
  });

  it("returns null when marking an unknown find", async () => {
    expect(await markFindHandled("main", "does-not-exist", "")).toBeNull();
  });
});
