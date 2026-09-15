import { getConfig } from "../../config.js";
import {
  addWatch,
  listFinds,
  listWatches,
  markFindHandled,
  offerPriceFor,
  removeWatch,
  runPass,
  runPassForAccount,
  seedWatch,
  type Watch,
} from "../../monitor/engine.js";
import { getStore, keys } from "../../store/index.js";
import { resolveAccount } from "../../vinted/accounts.js";
import { getSeller, getSellerItems } from "../../vinted/search.js";
import { jsonResult } from "../protocol.js";
import { optBoolean, optNumber, optString, requireString, type Tool } from "./types.js";

/**
 * Seller monitoring.
 *
 * The split here is deliberate: these tools watch sellers and surface what is
 * new, including the price a negotiation would open at. They do not contact
 * anybody. Turning a find into a like or an offer is a person's call, made in
 * Vinted - see docs/ACTIONS.md for why that boundary sits where it does.
 */

const accountProp = {
  account_id: {
    type: "string",
    description:
      "Which configured account to act as. Optional when only one is configured.",
  },
} as const;

const watchSeller: Tool = {
  name: "watch_seller",
  title: "Watch a seller",
  description:
    "Adds a seller to the watchlist. The seller's current listings are recorded as already seen, so only genuinely new items are reported from here on.",
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  inputSchema: {
    type: "object",
    properties: {
      ...accountProp,
      seller_id: { type: "string", description: "Numeric Vinted user id to watch." },
      discount_pct: {
        type: "number",
        description:
          "Negotiation discount for this seller, as a percentage off the asking price. Defaults to OFFER_DISCOUNT_PCT (20).",
      },
      domain: { type: "string", description: "Marketplace host for this seller." },
    },
    required: ["seller_id"],
    additionalProperties: false,
  },
  async handler(args) {
    const account = resolveAccount(optString(args, "account_id"));
    const sellerId = requireString(args, "seller_id");
    const domain = optString(args, "domain") ?? null;
    const store = getStore();

    const profile = await getSeller(sellerId, domain ?? undefined).catch(() => null);
    const items = await getSellerItems(sellerId, {
      account,
      ...(domain ? { domain } : {}),
    });
    const seeded = await seedWatch(account.id, sellerId, items);

    const watch: Watch = {
      sellerId,
      sellerLogin: profile?.login ?? items[0]?.sellerLogin ?? null,
      addedAt: new Date().toISOString(),
      domain,
      discountPct: optNumber(args, "discount_pct") ?? null,
    };
    await addWatch(account.id, watch);

    return jsonResult({
      watching: watch,
      account: account.id,
      seededItems: seeded,
      durableStorage: store.durable,
      note: store.durable
        ? "Watch saved. New listings will be picked up on the next monitor pass."
        : "Warning: no Upstash credentials are configured, so this watch lives in memory only and will not survive the next invocation. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.",
    });
  },
};

const unwatchSeller: Tool = {
  name: "unwatch_seller",
  title: "Stop watching a seller",
  description: "Removes a seller from the watchlist and forgets their seen-item history.",
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  inputSchema: {
    type: "object",
    properties: { ...accountProp, seller_id: { type: "string" } },
    required: ["seller_id"],
    additionalProperties: false,
  },
  async handler(args) {
    const account = resolveAccount(optString(args, "account_id"));
    const sellerId = requireString(args, "seller_id");
    await removeWatch(account.id, sellerId);
    return jsonResult({ unwatched: sellerId, account: account.id });
  },
};

const listWatchesTool: Tool = {
  name: "list_watches",
  title: "List watched sellers",
  description: "Shows which sellers this account watches and the discount each is set to.",
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: "object",
    properties: { ...accountProp },
    additionalProperties: false,
  },
  async handler(args) {
    const account = resolveAccount(optString(args, "account_id"));
    const watches = await listWatches(account.id);
    const store = getStore();
    return jsonResult({
      account: account.id,
      defaultDiscountPct: getConfig().offerDiscountPct,
      durableStorage: store.durable,
      lastMonitorRun: await store.get<string>(keys.lastRun()),
      watches,
    });
  },
};

const listNewFinds: Tool = {
  name: "list_new_finds",
  title: "List new listings from watched sellers",
  description:
    "Returns listings that watched sellers posted since the last check, each with its asking price and the suggested negotiation price (default 20% below asking). Nothing has been sent to the seller - these are findings for you to review and act on yourself.",
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: "object",
    properties: {
      ...accountProp,
      include_handled: {
        type: "boolean",
        description: "Also return finds already marked handled. Defaults to false.",
      },
      limit: { type: "number", description: "Maximum finds to return." },
    },
    additionalProperties: false,
  },
  async handler(args) {
    const account = resolveAccount(optString(args, "account_id"));
    const finds = await listFinds(account.id, {
      includeHandled: optBoolean(args, "include_handled") ?? false,
      limit: optNumber(args, "limit") ?? 50,
    });
    return jsonResult({
      account: account.id,
      count: finds.length,
      finds,
      note: "Suggested offer prices are calculations only. This server does not like items or send offers; open the listing URL to act.",
    });
  },
};

const markHandled: Tool = {
  name: "mark_find_handled",
  title: "Mark a find as handled",
  description:
    "Marks a find as dealt with so it stops showing up in list_new_finds. Use it after you have acted on the listing yourself.",
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  inputSchema: {
    type: "object",
    properties: {
      ...accountProp,
      item_id: { type: "string", description: "Item id of the find." },
      note: { type: "string", description: "Optional note about what you did." },
    },
    required: ["item_id"],
    additionalProperties: false,
  },
  async handler(args) {
    const account = resolveAccount(optString(args, "account_id"));
    const itemId = requireString(args, "item_id");
    const updated = await markFindHandled(
      account.id,
      itemId,
      optString(args, "note") ?? "",
    );
    return updated
      ? jsonResult({ handled: updated })
      : jsonResult({ handled: null, message: `No find recorded for item ${itemId}.` });
  },
};

const runMonitor: Tool = {
  name: "run_monitor_pass",
  title: "Run a monitoring pass now",
  description:
    "Polls every watched seller immediately instead of waiting for the scheduled cron run, and reports what is new.",
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  inputSchema: {
    type: "object",
    properties: {
      ...accountProp,
      all_accounts: {
        type: "boolean",
        description: "Run for every configured account rather than just one.",
      },
    },
    additionalProperties: false,
  },
  async handler(args) {
    if (optBoolean(args, "all_accounts")) {
      return jsonResult({ results: await runPass() });
    }
    const account = resolveAccount(optString(args, "account_id"));
    return jsonResult({ result: await runPassForAccount(account) });
  },
};

const previewOffer: Tool = {
  name: "preview_offer_price",
  title: "Preview a negotiation price",
  description:
    "Calculates what a negotiation offer would be for a given asking price, using the configured discount. Pure arithmetic - it contacts nobody.",
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    type: "object",
    properties: {
      asking_price: { type: "number", description: "The seller's asking price." },
      discount_pct: {
        type: "number",
        description: "Discount percentage. Defaults to OFFER_DISCOUNT_PCT.",
      },
    },
    required: ["asking_price"],
    additionalProperties: false,
  },
  async handler(args) {
    const asking = optNumber(args, "asking_price");
    const discountPct = optNumber(args, "discount_pct") ?? getConfig().offerDiscountPct;
    return jsonResult({
      askingPrice: asking,
      discountPct,
      offerPrice: offerPriceFor(asking ?? null, discountPct),
    });
  },
};

export const monitorTools: Tool[] = [
  watchSeller,
  unwatchSeller,
  listWatchesTool,
  listNewFinds,
  markHandled,
  runMonitor,
  previewOffer,
];
