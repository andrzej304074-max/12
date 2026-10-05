import { getConfig, parseActiveHours, type VintedAccount } from "../../config.js";
import {
  getFind,
  listFinds,
  markFindHandled,
  offerPriceFor,
} from "../../monitor/engine.js";
import {
  checkBudget,
  defaultLimits,
  getActionLog,
  getAutopause,
  getLimits,
  getOverrides,
  getUsage,
  inActiveWindow,
  localHour,
  resetLimits,
  resumeAutomation,
  setLimits,
  type ActionKind,
} from "../../monitor/safety.js";
import { resolveAccount } from "../../vinted/accounts.js";
import {
  deleteListing,
  likeItem,
  publishListing,
  sendMessage,
  sendOffer,
} from "../../vinted/actions.js";
import { getItem } from "../../vinted/search.js";
import { jsonResult, type ToolResult } from "../protocol.js";
import { checkDraft } from "./listing.js";
import {
  ArgumentError,
  optBoolean,
  optNumber,
  optNumberArray,
  optString,
  requireString,
  type Tool,
} from "./types.js";

/**
 * Tools that change something on Vinted.
 *
 * Each one is a two-step: called without `confirm: true` it only describes
 * what it would send and whether the limits allow it; with `confirm: true` it
 * sends. All are annotated destructive so clients ask before running them.
 */

const DESTRUCTIVE = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
} as const;

const accountProp = {
  type: "string",
  description: "Which configured account acts. Optional when only one is configured.",
} as const;

const confirmProp = {
  type: "boolean",
  description:
    "Must be true to actually send. Without it the tool returns a preview and sends nothing.",
} as const;

async function preview(
  account: VintedAccount,
  kind: ActionKind,
  wouldSend: Record<string, unknown>,
): Promise<ToolResult> {
  const budget = await checkBudget(account.id, kind, { automatic: false });
  return jsonResult({
    preview: true,
    sent: false,
    account: account.id,
    action: kind,
    wouldSend,
    allowedNow: budget.ok,
    ...(budget.ok ? {} : { blockedBecause: budget.message }),
    next: "Call again with confirm: true to send.",
  });
}

const likeItemTool: Tool = {
  name: "like_item",
  title: "Like a listing",
  description:
    "Adds a listing to the account's favourites. Needs confirm: true; counts against the daily like limit.",
  annotations: DESTRUCTIVE,
  inputSchema: {
    type: "object",
    properties: {
      account_id: accountProp,
      item_id: { type: "string", description: "Numeric Vinted item id." },
      confirm: confirmProp,
    },
    required: ["item_id"],
    additionalProperties: false,
  },
  async handler(args) {
    const account = resolveAccount(optString(args, "account_id"));
    const itemId = requireString(args, "item_id");
    if (optBoolean(args, "confirm") !== true) {
      return preview(account, "like", { itemId });
    }
    await likeItem(account, itemId);
    return jsonResult({ sent: true, action: "like", itemId, account: account.id });
  },
};

const makeOfferTool: Tool = {
  name: "make_offer",
  title: "Make a price offer",
  description:
    "Sends a price offer on a listing. Without `price`, offers the asking price minus the account discount (default 20%). Needs confirm: true; counts against the daily offer limit.",
  annotations: DESTRUCTIVE,
  inputSchema: {
    type: "object",
    properties: {
      account_id: accountProp,
      item_id: { type: "string", description: "Numeric Vinted item id." },
      price: { type: "number", description: "Offer amount. Defaults to asking minus discount." },
      discount_pct: { type: "number", description: "Discount used when price is omitted." },
      confirm: confirmProp,
    },
    required: ["item_id"],
    additionalProperties: false,
  },
  async handler(args) {
    const account = resolveAccount(optString(args, "account_id"));
    const itemId = requireString(args, "item_id");
    let price = optNumber(args, "price");
    let currency: string | null = null;
    let askingPrice: number | null = null;

    if (price === undefined) {
      const item = await getItem(itemId, account.domain);
      if (!item) throw new ArgumentError(`Listing ${itemId} was not found.`);
      askingPrice = item.price;
      currency = item.currency;
      const discount =
        optNumber(args, "discount_pct") ?? (await getLimits(account.id)).discountPct;
      price = offerPriceFor(item.price, discount) ?? undefined;
      if (price === undefined) {
        throw new ArgumentError("The listing has no usable price; pass `price` explicitly.");
      }
    }

    if (optBoolean(args, "confirm") !== true) {
      return preview(account, "offer", { itemId, price, currency, askingPrice });
    }
    await sendOffer(account, itemId, price, currency);
    return jsonResult({ sent: true, action: "offer", itemId, price, currency, account: account.id });
  },
};

const processFindTool: Tool = {
  name: "process_find",
  title: "Like and offer on a find",
  description:
    "For a find from list_new_finds: likes it and sends the suggested discounted offer, then marks it handled. Needs confirm: true.",
  annotations: DESTRUCTIVE,
  inputSchema: {
    type: "object",
    properties: {
      account_id: accountProp,
      item_id: { type: "string", description: "Item id of the find." },
      like: { type: "boolean", description: "Like it. Defaults to true." },
      offer: { type: "boolean", description: "Send the offer. Defaults to true." },
      price: { type: "number", description: "Override the suggested offer price." },
      confirm: confirmProp,
    },
    required: ["item_id"],
    additionalProperties: false,
  },
  async handler(args) {
    const account = resolveAccount(optString(args, "account_id"));
    const itemId = requireString(args, "item_id");
    const find = await getFind(account.id, itemId);
    if (!find) throw new ArgumentError(`No find recorded for item ${itemId}.`);

    const doLike = optBoolean(args, "like") ?? true;
    const doOffer = optBoolean(args, "offer") ?? true;
    const price = optNumber(args, "price") ?? find.suggestedOfferPrice;
    if (doOffer && (price === null || price === undefined)) {
      throw new ArgumentError("The find has no usable price; pass `price` or set offer: false.");
    }

    if (optBoolean(args, "confirm") !== true) {
      const likeBudget = doLike ? await checkBudget(account.id, "like", { automatic: false }) : null;
      const offerBudget = doOffer
        ? await checkBudget(account.id, "offer", { automatic: false })
        : null;
      return jsonResult({
        preview: true,
        sent: false,
        find,
        wouldLike: doLike,
        wouldOffer: doOffer ? { price, currency: find.currency } : false,
        likeAllowed: likeBudget?.ok ?? null,
        offerAllowed: offerBudget?.ok ?? null,
        next: "Call again with confirm: true to send.",
      });
    }

    const results: { action: string; ok: boolean; detail: string }[] = [];
    if (doLike) {
      try {
        await likeItem(account, itemId);
        results.push({ action: "like", ok: true, detail: "liked" });
      } catch (err) {
        results.push({ action: "like", ok: false, detail: (err as Error).message });
      }
    }
    if (doOffer) {
      try {
        await sendOffer(account, itemId, price as number, find.currency);
        results.push({ action: "offer", ok: true, detail: `offered ${price}` });
      } catch (err) {
        results.push({ action: "offer", ok: false, detail: (err as Error).message });
      }
    }
    if (results.some((r) => r.ok)) {
      await markFindHandled(account.id, itemId, results.map((r) => r.detail).join("; "));
    }
    return jsonResult({ itemId, account: account.id, results });
  },
};

const sendMessageTool: Tool = {
  name: "send_message",
  title: "Message a seller about a listing",
  description: "Sends a message in the conversation about a listing. Needs confirm: true.",
  annotations: DESTRUCTIVE,
  inputSchema: {
    type: "object",
    properties: {
      account_id: accountProp,
      item_id: { type: "string", description: "Listing the conversation is about." },
      text: { type: "string", description: "Message text." },
      confirm: confirmProp,
    },
    required: ["item_id", "text"],
    additionalProperties: false,
  },
  async handler(args) {
    const account = resolveAccount(optString(args, "account_id"));
    const itemId = requireString(args, "item_id");
    const text = requireString(args, "text");
    if (text.length > 2000) throw new ArgumentError("Message is longer than 2000 characters.");
    if (optBoolean(args, "confirm") !== true) {
      return preview(account, "message", { itemId, text });
    }
    await sendMessage(account, itemId, text);
    return jsonResult({ sent: true, action: "message", itemId, account: account.id });
  },
};

const publishListingTool: Tool = {
  name: "publish_listing",
  title: "Publish a listing",
  description:
    "Publishes a listing on the account. Runs the same checks as validate_listing first and refuses on any blocker. Photos must already be uploaded to Vinted; pass their ids. Needs confirm: true.",
  annotations: DESTRUCTIVE,
  inputSchema: {
    type: "object",
    properties: {
      account_id: accountProp,
      title: { type: "string" },
      description: { type: "string" },
      price: { type: "number" },
      currency: { type: "string" },
      brand: { type: "string" },
      brand_id: { type: "number" },
      size: { type: "string" },
      condition: { type: "string" },
      catalog_id: { type: "number" },
      photo_ids: {
        type: "array",
        items: { type: "number" },
        description: "Ids of photos already uploaded to Vinted.",
      },
      confirm: confirmProp,
    },
    required: ["title", "description", "price", "catalog_id", "photo_ids"],
    additionalProperties: false,
  },
  async handler(args) {
    const account = resolveAccount(optString(args, "account_id"));
    const photoIds = optNumberArray(args, "photo_ids") ?? [];
    const draft = {
      title: requireString(args, "title"),
      description: requireString(args, "description"),
      price: optNumber(args, "price"),
      currency: optString(args, "currency"),
      brand: optString(args, "brand"),
      size: optString(args, "size"),
      condition: optString(args, "condition"),
      catalogId: optNumber(args, "catalog_id"),
      brandId: optNumber(args, "brand_id"),
      photoCount: photoIds.length,
    };
    const blockers = checkDraft(draft).filter((i) => i.severity === "blocker");
    if (blockers.length) {
      return jsonResult({
        sent: false,
        refused: "The draft has blockers; fix them first.",
        blockers,
      });
    }
    const payload = {
      title: draft.title,
      description: draft.description,
      price: draft.price as number,
      currency: draft.currency ?? null,
      catalogId: draft.catalogId as number,
      brandId: draft.brandId ?? null,
      brand: draft.brand ?? null,
      size: draft.size ?? null,
      condition: draft.condition ?? null,
      photoIds,
    };
    if (optBoolean(args, "confirm") !== true) {
      return preview(account, "publish", payload);
    }
    const outcome = await publishListing(account, payload);
    return jsonResult({ sent: true, action: "publish", account: account.id, response: outcome.response });
  },
};

const deleteListingTool: Tool = {
  name: "delete_listing",
  title: "Delete a listing",
  description: "Deletes one of the account's own listings. Irreversible. Needs confirm: true.",
  annotations: DESTRUCTIVE,
  inputSchema: {
    type: "object",
    properties: {
      account_id: accountProp,
      item_id: { type: "string", description: "Id of your own listing." },
      confirm: confirmProp,
    },
    required: ["item_id"],
    additionalProperties: false,
  },
  async handler(args) {
    const account = resolveAccount(optString(args, "account_id"));
    const itemId = requireString(args, "item_id");
    if (optBoolean(args, "confirm") !== true) {
      return preview(account, "delete", { itemId });
    }
    await deleteListing(account, itemId);
    return jsonResult({ sent: true, action: "delete", itemId, account: account.id });
  },
};

const setLimitsTool: Tool = {
  name: "set_automation_limits",
  title: "Set automation limits",
  description:
    "Changes an account's limits at runtime, without a redeploy. Only the fields you pass change; 0 disables that action. Environment variables stay as defaults. Pass reset: true to go back to the defaults.",
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  inputSchema: {
    type: "object",
    properties: {
      account_id: accountProp,
      likes_per_day: { type: "number", description: "Max likes per day (0 = off)." },
      offers_per_day: { type: "number", description: "Max offers per day (0 = off)." },
      actions_per_hour: {
        type: "number",
        description: "Max automatic actions per hour (0 = automation off).",
      },
      active_hours: {
        type: "string",
        description: 'Window for automatic actions, local time, e.g. "8-22" or "22-6".',
      },
      autopause_hours: {
        type: "number",
        description: "How long automation pauses after Vinted refuses an action.",
      },
      discount_pct: { type: "number", description: "Default offer discount, 0-90." },
      reset: { type: "boolean", description: "Drop all overrides for the account." },
    },
    additionalProperties: false,
  },
  async handler(args) {
    const account = resolveAccount(optString(args, "account_id"));
    if (optBoolean(args, "reset")) {
      return jsonResult({ account: account.id, limits: await resetLimits(account.id), reset: true });
    }
    const patch: Record<string, unknown> = {};
    const map: [string, string][] = [
      ["likes_per_day", "likesPerDay"],
      ["offers_per_day", "offersPerDay"],
      ["actions_per_hour", "actionsPerHour"],
      ["autopause_hours", "autopauseHours"],
      ["discount_pct", "discountPct"],
    ];
    for (const [arg, field] of map) {
      const value = optNumber(args, arg);
      if (value !== undefined) patch[field] = value;
    }
    const hours = optString(args, "active_hours");
    if (hours !== undefined) {
      try {
        patch.activeHours = parseActiveHours(hours);
      } catch (err) {
        throw new ArgumentError((err as Error).message);
      }
    }
    if (Object.keys(patch).length === 0) {
      throw new ArgumentError("Pass at least one limit to change, or reset: true.");
    }
    const limits = await setLimits(account.id, patch);
    return jsonResult({ account: account.id, limits, changed: Object.keys(patch) });
  },
};

const statusTool: Tool = {
  name: "get_automation_status",
  title: "Automation status",
  description:
    "Shows whether automation is on, the effective limits and where each comes from, today's usage, the activity window, any pause, the queue of pending automatic actions and the recent action log.",
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    type: "object",
    properties: { account_id: accountProp },
    additionalProperties: false,
  },
  async handler(args) {
    const cfg = getConfig();
    const account = resolveAccount(optString(args, "account_id"));
    const limits = await getLimits(account.id);
    const overrides = await getOverrides(account.id);
    const hour = localHour();
    const queue = (await listFinds(account.id)).filter((f) => f.autoPending?.length);
    const source = Object.fromEntries(
      Object.keys(defaultLimits()).map((k) => [k, k in overrides ? "set at runtime" : "environment"]),
    );
    return jsonResult({
      account: account.id,
      autoActionsEnabled: cfg.autoActionsEnabled,
      limits,
      limitSource: source,
      usage: await getUsage(account.id),
      activityWindow: {
        ...limits.activeHours,
        timeZone: cfg.timeZone,
        localHourNow: hour,
        insideNow: inActiveWindow(hour, limits.activeHours),
      },
      autopause: await getAutopause(account.id),
      queue: queue.map((f) => ({ itemId: f.itemId, title: f.title, pending: f.autoPending })),
      recentActions: (await getActionLog(account.id)).slice(0, 15),
    });
  },
};

const resumeTool: Tool = {
  name: "resume_automation",
  title: "Resume automation",
  description:
    "Clears the circuit-breaker pause for an account. Check why it tripped in get_automation_status first - resuming into the same refusal just trips it again.",
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  inputSchema: {
    type: "object",
    properties: { account_id: accountProp },
    additionalProperties: false,
  },
  async handler(args) {
    const account = resolveAccount(optString(args, "account_id"));
    const was = await getAutopause(account.id);
    await resumeAutomation(account.id);
    return jsonResult({ account: account.id, resumed: true, previousPause: was });
  },
};

export const actionTools: Tool[] = [
  likeItemTool,
  makeOfferTool,
  processFindTool,
  sendMessageTool,
  publishListingTool,
  deleteListingTool,
  setLimitsTool,
  statusTool,
  resumeTool,
];
