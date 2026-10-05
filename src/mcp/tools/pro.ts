import { cleanSnippet } from "../../vinted/evidence.js";
import {
  deleteProAccount,
  getProAccount,
  listProAccounts,
  type ProAccount,
} from "../../pro/accounts.js";
import { getProActions } from "../../pro/actionlog.js";
import { getProClient } from "../../pro/client.js";
import { ProError, ProInputError } from "../../pro/errors.js";
import { assertProPath, proBaseUrl } from "../../pro/hosts.js";
import {
  createItems,
  deleteItems,
  getItemStatus,
  listImportedItems,
  listItems,
  priceSuggestion,
  setItemReferences,
  updateItems,
  validateItems,
  type WriteResult,
} from "../../pro/items.js";
import {
  describeOntology,
  findCategories,
  indexCategories,
  loadOntology,
  type CategoryInfo,
} from "../../pro/ontology.js";
import {
  cancelOrder,
  getLabel,
  getOrder,
  getShipment,
  listOrders,
  relistOrders,
} from "../../pro/orders.js";
import {
  CANCEL_REASON_MAX,
  checkItemUpdate,
  checkNewItem,
  MAX_BATCH,
  type ItemProblem,
} from "../../pro/schema.js";
import { getItemStates } from "../../pro/state.js";
import { jsonResult, type ToolResult } from "../protocol.js";
import {
  ArgumentError,
  optBoolean,
  optNumber,
  optString,
  requireString,
  type Tool,
} from "./types.js";

/**
 * Tools for the official Vinted Pro Integrations API: own listings, orders,
 * labels and the dictionaries a listing is built from.
 *
 * Reads run as they are. Every write is a two-step: called without
 * `confirm: true` it validates what it can and describes what it would send;
 * with `confirm: true` it sends. Creating listings makes drafts unless
 * `publish: true` is given.
 *
 * Text that comes back from Vinted (item and order data) was written by other
 * people and is data, never instructions.
 */

const READ = { readOnlyHint: true, openWorldHint: true } as const;
const WRITE = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
} as const;

const accountProp = {
  type: "string",
  description: "Which Vinted Pro account acts (see pro_list_accounts). Optional when only one is connected.",
} as const;
const confirmProp = {
  type: "boolean",
  description: "Must be true to actually send. Without it the tool returns a preview and sends nothing.",
} as const;

const MAX_ITEMS_PER_CALL = 500;
const MAX_OUTPUT_CHARS = 60_000;

function requireObjects(args: Record<string, unknown>, name: string): Record<string, unknown>[] {
  const value = args[name];
  if (!Array.isArray(value) || value.length === 0) {
    throw new ArgumentError(`"${name}" is required: a non-empty list of objects.`);
  }
  if (value.length > MAX_ITEMS_PER_CALL) {
    throw new ArgumentError(`At most ${MAX_ITEMS_PER_CALL} items per call (they are sent in requests of ${MAX_BATCH}).`);
  }
  return value as Record<string, unknown>[];
}

function requireStrings(args: Record<string, unknown>, name: string): string[] {
  const value = args[name];
  if (!Array.isArray(value) || value.length === 0 || !value.every((v) => typeof v === "string" || typeof v === "number")) {
    throw new ArgumentError(`"${name}" is required: a non-empty list of ids.`);
  }
  if (value.length > MAX_ITEMS_PER_CALL) {
    throw new ArgumentError(`At most ${MAX_ITEMS_PER_CALL} ids per call.`);
  }
  return (value as (string | number)[]).map(String);
}

/** Caps a value for a tool answer so one call cannot flood a client. */
function capped(value: unknown, max = MAX_OUTPUT_CHARS): unknown {
  const text = JSON.stringify(value);
  if (text === undefined || text.length <= max) return value;
  return { truncated: true, totalCharacters: text.length, preview: text.slice(0, max) };
}

function preview(account: ProAccount, action: string, wouldSend: Record<string, unknown>, extra: Record<string, unknown> = {}): ToolResult {
  return jsonResult({
    preview: true,
    sent: false,
    account: account.id,
    environment: account.env,
    action,
    wouldSend,
    ...extra,
    next: "Call again with confirm: true to send.",
  });
}

function summariseWrite(result: WriteResult) {
  return {
    itemsSent: result.itemsSent,
    requests: result.requests,
    ...(result.stoppedBecause ? { stoppedBecause: result.stoppedBecause, warning: "Earlier requests were already accepted." } : {}),
    answers: capped(result.accepted, 20_000),
  };
}

/** The ontology if it can be had; category checks are skipped when it cannot. */
async function categoriesFor(account: ProAccount): Promise<{ byId: Map<number, CategoryInfo> | null; note: string | null }> {
  try {
    const loaded = await loadOntology(account);
    return { byId: new Map(indexCategories(loaded.raw).map((c) => [c.id, c])), note: null };
  } catch (err) {
    if (err instanceof ProError) {
      return { byId: null, note: `Category checks were skipped: ${err.message}` };
    }
    throw err;
  }
}

function problemsOf(checked: { problems: ItemProblem[] }[]): ItemProblem[] {
  return checked.flatMap((c) => c.problems);
}

// ---------------------------------------------------------------- accounts

const listAccountsTool: Tool = {
  name: "pro_list_accounts",
  title: "List Vinted Pro accounts",
  description:
    "Shows the connected Vinted Pro accounts, their environment (sandbox or production), whether Vinted accepted the token, and whether a webhook is registered. Tokens are never returned.",
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  async handler() {
    return jsonResult({
      accounts: await listProAccounts(),
      note: "Tokens are added in the web panel (Konta), not through a tool.",
    });
  },
};

function verdictFor(err: ProError): string {
  switch (err.kind) {
    case "auth":
      return "unauthorized";
    case "forbidden":
      return "forbidden";
    case "rate_limited":
      return "rate_limited";
    case "server":
      return "server_error";
    case "network":
      return "network";
    case "config":
      return "config";
    default:
      return "unexpected";
  }
}

function hintsFor(err: ProError, account: ProAccount): string[] {
  const hints: string[] = [];
  if (err.kind === "auth") {
    hints.push(`This server's clock says ${new Date().toISOString()}; the timestamp is part of every signature.`);
    hints.push(`The account is set to "${account.env}": a sandbox token only works against the sandbox and a production token only against production.`);
    hints.push("Copy the token again from the Vinted Pro portal; it is one string, <access_key>,<signing_key>.");
  }
  if (err.kind === "forbidden") {
    hints.push("The Vinted account must be on the Pro Integrations allowlist.");
    hints.push("The documentation lists AT, BE, DE, ES, FR, IT, LU, NL, PT and UK. Poland is not on it: ask Vinted whether a Polish account (PLN) is supported.");
  }
  if (err.kind === "network") hints.push("This server could not reach Vinted Pro at all.");
  return hints;
}

const diagnoseProTool: Tool = {
  name: "diagnose_pro",
  title: "Check the Vinted Pro connection",
  description:
    "Signs a harmless read (GET /api/v1/ontologies) with the account's token and reports exactly what Vinted answered: whether the signature and token are accepted, whether the account is allowed, and what the ontology contains. Run it first after adding a token, and whenever something starts failing.",
  annotations: READ,
  inputSchema: {
    type: "object",
    properties: { account_id: accountProp },
    additionalProperties: false,
  },
  async handler(args) {
    const account = await getProAccount(optString(args, "account_id"));
    const where = { account: account.id, environment: account.env, baseUrl: proBaseUrl(account.env) };
    const server = { time: new Date().toISOString(), unix: Math.floor(Date.now() / 1000) };
    try {
      const loaded = await loadOntology(account, { refresh: true });
      return jsonResult({
        ok: true,
        verdict: "ok",
        ...where,
        server,
        ontology: describeOntology(loaded.raw),
        next: "The token works. Use pro_find_category and pro_validate_items to prepare a listing.",
      });
    } catch (err) {
      if (err instanceof ProError) {
        return jsonResult({
          ok: false,
          verdict: verdictFor(err),
          ...where,
          server,
          status: err.status,
          code: err.code,
          message: err.message,
          hints: hintsFor(err, account),
        });
      }
      throw err;
    }
  },
};

const removeAccountTool: Tool = {
  name: "pro_remove_account",
  title: "Remove a Vinted Pro account",
  description:
    "Disconnects a Vinted Pro account here and deletes the stored token, cached ontology, event log and item index. Nothing is deleted at Vinted (listings stay); a webhook registered at Vinted keeps existing until it is removed with pro_delete_webhook. Needs confirm: true.",
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  inputSchema: {
    type: "object",
    properties: { account_id: accountProp, confirm: confirmProp },
    required: ["account_id"],
    additionalProperties: false,
  },
  async handler(args) {
    const account = await getProAccount(requireString(args, "account_id"));
    if (optBoolean(args, "confirm") !== true) {
      return jsonResult({
        preview: true,
        removed: false,
        account: account.id,
        wouldDelete: "the stored token, cached ontology, event log, action log and item index of this account",
        next: "Call again with confirm: true to remove.",
      });
    }
    await deleteProAccount(account.id);
    return jsonResult({ removed: true, account: account.id });
  },
};

// ---------------------------------------------------------------- ontology

const getOntologyTool: Tool = {
  name: "pro_get_ontology",
  title: "Read the Vinted ontology",
  description:
    "The dictionaries a listing is built from (categories, colours, package sizes, item conditions, size groups). Without `key` it summarises the top-level sections and counts; with `key` it returns that section as Vinted sent it. The ontology is cached for a day; refresh: true fetches it again.",
  annotations: READ,
  inputSchema: {
    type: "object",
    properties: {
      account_id: accountProp,
      key: { type: "string", description: "A top-level section name from the summary, e.g. \"colors\"." },
      refresh: { type: "boolean", description: "Fetch again instead of using the cached copy." },
    },
    additionalProperties: false,
  },
  async handler(args) {
    const account = await getProAccount(optString(args, "account_id"));
    const loaded = await loadOntology(account, { refresh: optBoolean(args, "refresh") === true });
    const key = optString(args, "key");
    if (!key) {
      return jsonResult({ account: account.id, fetchedAt: loaded.fetchedAt, fromCache: loaded.fromCache, ...describeOntology(loaded.raw) });
    }
    const raw = loaded.raw;
    const section =
      raw && typeof raw === "object" && !Array.isArray(raw) && key in (raw as Record<string, unknown>)
        ? (raw as Record<string, unknown>)[key]
        : undefined;
    if (section === undefined) {
      throw new ArgumentError(`The ontology has no section "${key}". Sections: ${describeOntology(raw).topLevelKeys.map((k) => k.key).join(", ")}.`);
    }
    return jsonResult({ account: account.id, key, data: capped(section) });
  },
};

const findCategoryTool: Tool = {
  name: "pro_find_category",
  title: "Find a Vinted category",
  description:
    "Finds categories whose path contains every word of the query, leaves first. A listing needs a leaf category id (catalog_id); the result also shows the size groups, attribute ids and disabled fields of each category.",
  annotations: READ,
  inputSchema: {
    type: "object",
    properties: {
      account_id: accountProp,
      query: { type: "string", description: "Words from the category name, e.g. \"jeansowe kurtki\"." },
      limit: { type: "number", description: "How many matches to return (default 10, at most 50)." },
    },
    required: ["query"],
    additionalProperties: false,
  },
  async handler(args) {
    const account = await getProAccount(optString(args, "account_id"));
    const loaded = await loadOntology(account);
    const limit = Math.min(Math.max(optNumber(args, "limit") ?? 10, 1), 50);
    const matches = findCategories(indexCategories(loaded.raw), requireString(args, "query"), limit);
    return jsonResult({
      account: account.id,
      count: matches.length,
      categories: matches.map((c) => ({
        catalog_id: c.id,
        path: c.path.join(" › "),
        leaf: c.leaf,
        size_group_ids: c.sizeGroupIds,
        item_attribute_ids: c.attributeIds,
        disabled_fields: c.disabledFields,
      })),
    });
  },
};

const priceSuggestionTool: Tool = {
  name: "pro_price_suggestion",
  title: "Get a price suggestion",
  description: "Vinted's suggested price for a category, optionally narrowed by brand id and item condition id.",
  annotations: READ,
  inputSchema: {
    type: "object",
    properties: {
      account_id: accountProp,
      catalog_id: { type: "number", description: "Leaf category id." },
      brand_id: { type: "number" },
      status_id: { type: "number", description: "Item condition id from the ontology." },
    },
    required: ["catalog_id"],
    additionalProperties: false,
  },
  async handler(args) {
    const account = await getProAccount(optString(args, "account_id"));
    const catalogId = optNumber(args, "catalog_id");
    if (catalogId === undefined) throw new ArgumentError(`"catalog_id" is required.`);
    const brandId = optNumber(args, "brand_id");
    const statusId = optNumber(args, "status_id");
    return jsonResult({
      account: account.id,
      suggestion: await priceSuggestion(account, {
        catalogId,
        ...(brandId !== undefined ? { brandId } : {}),
        ...(statusId !== undefined ? { statusId } : {}),
      }),
    });
  },
};

// ---------------------------------------------------------------- items

const itemsSchema = {
  type: "array",
  description:
    "Items with the field names of the Vinted Pro API: title, description, price, catalog_id (leaf), status_id, package_size_id, brand (text), color_ids, size_id, item_attributes, photo_urls (public https addresses), reference (your SKU), is_draft.",
  items: { type: "object" },
} as const;

const listItemsTool: Tool = {
  name: "pro_list_items",
  title: "List own listings",
  description:
    "Lists the account's listings managed through Pro Integrations, with a cursor (after_item_id). The answer is shown as Vinted sent it. `tracked` is what this server last heard about items it created or got webhooks for.",
  annotations: READ,
  inputSchema: {
    type: "object",
    properties: {
      account_id: accountProp,
      after_item_id: { type: "string", description: "Cursor: the last item id of the previous page." },
      limit: { type: "number", description: "Page size." },
    },
    additionalProperties: false,
  },
  async handler(args) {
    const account = await getProAccount(optString(args, "account_id"));
    const after = optString(args, "after_item_id");
    const limit = optNumber(args, "limit");
    const data = await listItems(account, { ...(after ? { afterItemId: after } : {}), ...(limit !== undefined ? { limit } : {}) });
    return jsonResult({ account: account.id, data: capped(data), tracked: (await getItemStates(account.id)).slice(0, 50) });
  },
};

const itemStatusTool: Tool = {
  name: "pro_get_item_status",
  title: "Get a listing's processing status",
  description:
    "The processing status of one listing (e.g. IN_PROGRESS right after creating). Creation, edits and deletion are asynchronous: this, or a webhook, tells the outcome.",
  annotations: READ,
  inputSchema: {
    type: "object",
    properties: { account_id: accountProp, item_id: { type: "string", description: "Vinted's item id (UUID)." } },
    required: ["item_id"],
    additionalProperties: false,
  },
  async handler(args) {
    const account = await getProAccount(optString(args, "account_id"));
    const itemId = requireString(args, "item_id");
    return jsonResult({ account: account.id, itemId, status: await getItemStatus(account, itemId) });
  },
};

const validateItemsTool: Tool = {
  name: "pro_validate_items",
  title: "Validate listings",
  description:
    "Checks listings without creating anything: first the rules that can be checked here (required fields, leaf category, disabled fields), then Vinted's own validation (POST /api/v1/items/validate). Use it before pro_create_items.",
  annotations: READ,
  inputSchema: {
    type: "object",
    properties: { account_id: accountProp, items: itemsSchema },
    required: ["items"],
    additionalProperties: false,
  },
  async handler(args) {
    const account = await getProAccount(optString(args, "account_id"));
    const items = requireObjects(args, "items");
    const { byId, note } = await categoriesFor(account);
    const checked = items.map((item, i) =>
      checkNewItem(item, i, { category: byId?.get(Number((item as Record<string, unknown>).catalog_id)) ?? null, draftByDefault: true }),
    );
    const problems = problemsOf(checked);
    const sendable = checked.flatMap((c) => (c.payload ? [c.payload] : []));
    const api = sendable.length > 0 ? await validateItems(account, sendable) : null;
    return jsonResult({
      account: account.id,
      checkedLocally: items.length,
      problems,
      ...(note ? { note } : {}),
      vinted: api,
      ok: !problems.some((p) => p.level === "error") && (api?.invalid ?? 0) === 0,
    });
  },
};

const createItemsTool: Tool = {
  name: "pro_create_items",
  title: "Create listings",
  description:
    "Creates listings (up to 500 per call, sent in requests of 100). They are created as DRAFTS unless publish: true is given. Vinted's validation runs first and nothing is created if it finds errors (skip_validation: true overrides). Creation is asynchronous: follow it with pro_get_item_status or pro_list_events. Needs confirm: true.",
  annotations: WRITE,
  inputSchema: {
    type: "object",
    properties: {
      account_id: accountProp,
      items: itemsSchema,
      publish: { type: "boolean", description: "Publish at once instead of creating drafts." },
      skip_validation: { type: "boolean", description: "Do not run Vinted's validation first." },
      confirm: confirmProp,
    },
    required: ["items"],
    additionalProperties: false,
  },
  async handler(args) {
    const account = await getProAccount(optString(args, "account_id"));
    const items = requireObjects(args, "items");
    const publish = optBoolean(args, "publish") === true;
    const { byId, note } = await categoriesFor(account);

    const checked = items.map((item, i) =>
      checkNewItem(item, i, { category: byId?.get(Number((item as Record<string, unknown>).catalog_id)) ?? null, draftByDefault: !publish }),
    );
    const problems = problemsOf(checked);
    checked.forEach((c, i) => {
      if (c.payload && c.payload.is_draft === false && !publish) {
        problems.push({ index: i, field: "is_draft", message: "This would publish a live listing; pass publish: true to confirm that is intended.", level: "error" });
      }
    });
    const blocking = problems.some((p) => p.level === "error");
    const payloads = checked.flatMap((c) => (c.payload ? [c.payload] : []));
    const removed = [...new Set(checked.flatMap((c) => c.removedFields))];

    if (optBoolean(args, "confirm") !== true) {
      return preview(
        account,
        "create_items",
        {
          items: items.length,
          requests: Math.ceil(items.length / MAX_BATCH),
          mode: publish ? "publish immediately" : "drafts",
          firstItem: payloads[0] ? { title: payloads[0].title, price: payloads[0].price, catalog_id: payloads[0].catalog_id, photos: Array.isArray(payloads[0].photo_urls) ? payloads[0].photo_urls.length : 0 } : null,
        },
        { problems, ...(removed.length ? { fieldsRemovedForCategory: removed } : {}), ...(note ? { note } : {}), blocked: blocking },
      );
    }
    if (blocking) return jsonResult({ created: false, blocked: true, problems });

    if (optBoolean(args, "skip_validation") !== true) {
      const validation = await validateItems(account, payloads);
      if (validation.invalid > 0) {
        return jsonResult({
          created: false,
          reason: "Vinted's validation found errors; nothing was created.",
          validation,
          next: "Fix the items, or pass skip_validation: true to send anyway.",
        });
      }
    }
    const result = await createItems(account, payloads);
    return jsonResult({
      created: result.itemsSent > 0,
      account: account.id,
      mode: publish ? "published" : "drafts",
      ...summariseWrite(result),
      asynchronous: "Vinted processes creation in the background. Follow it with pro_get_item_status or pro_list_events.",
    });
  },
};

const updateItemsTool: Tool = {
  name: "pro_update_items",
  title: "Update listings",
  description:
    "Changes listings. Each item needs `id` (Vinted's UUID) and the fields to change (price, title, description, photo_urls, is_draft ...). Up to 500 per call, sent in requests of 100. Asynchronous: the outcome comes by webhook. Needs confirm: true.",
  annotations: WRITE,
  inputSchema: {
    type: "object",
    properties: { account_id: accountProp, items: itemsSchema, confirm: confirmProp },
    required: ["items"],
    additionalProperties: false,
  },
  async handler(args) {
    const account = await getProAccount(optString(args, "account_id"));
    const items = requireObjects(args, "items");
    const checked = items.map((item, i) => checkItemUpdate(item, i));
    const problems = problemsOf(checked);
    const blocking = problems.some((p) => p.level === "error");
    const payloads = checked.flatMap((c) => (c.payload ? [c.payload] : []));
    if (optBoolean(args, "confirm") !== true) {
      return preview(
        account,
        "update_items",
        { items: items.length, requests: Math.ceil(items.length / MAX_BATCH), fields: [...new Set(payloads.flatMap((p) => Object.keys(p).filter((k) => k !== "id")))] },
        { problems, blocked: blocking },
      );
    }
    if (blocking) return jsonResult({ updated: false, blocked: true, problems });
    const result = await updateItems(account, payloads);
    return jsonResult({ updated: result.itemsSent > 0, account: account.id, ...summariseWrite(result), asynchronous: "The outcome arrives by webhook (UPDATE_ITEM_SUCCESS / UPDATE_ITEM_FAILURE)." });
  },
};

const deleteItemsTool: Tool = {
  name: "pro_delete_items",
  title: "Delete listings",
  description:
    "Deletes listings by their Vinted ids. Only items that were created successfully can be deleted (not IN_PROGRESS ones). Vinted answers 202 even for unknown ids; the outcome arrives by webhook (DELETE_ITEM_SUCCESS / DELETE_ITEM_FAILURE). Needs confirm: true.",
  annotations: WRITE,
  inputSchema: {
    type: "object",
    properties: {
      account_id: accountProp,
      item_ids: { type: "array", items: { type: "string" }, description: "Vinted item ids (UUIDs)." },
      confirm: confirmProp,
    },
    required: ["item_ids"],
    additionalProperties: false,
  },
  async handler(args) {
    const account = await getProAccount(optString(args, "account_id"));
    const ids = requireStrings(args, "item_ids");
    if (optBoolean(args, "confirm") !== true) {
      return preview(account, "delete_items", { itemIds: ids.length, requests: Math.ceil(ids.length / MAX_BATCH), ids: ids.slice(0, 20) });
    }
    const result = await deleteItems(account, ids);
    return jsonResult({ deleted: result.itemsSent > 0, account: account.id, ...summariseWrite(result), asynchronous: "Vinted answers 202 even for ids it does not know; check the webhook outcome." });
  },
};

const importedItemsTool: Tool = {
  name: "pro_list_imported_items",
  title: "List imported listings",
  description:
    "Listings that were added on Vinted outside the API and imported into Pro Integrations. Give them a reference (SKU) with pro_set_item_references to manage them here.",
  annotations: READ,
  inputSchema: {
    type: "object",
    properties: {
      account_id: accountProp,
      after_item_id: { type: "string", description: "Cursor from the previous page." },
      limit: { type: "number" },
    },
    additionalProperties: false,
  },
  async handler(args) {
    const account = await getProAccount(optString(args, "account_id"));
    const after = optString(args, "after_item_id");
    const limit = optNumber(args, "limit");
    return jsonResult({ account: account.id, data: capped(await listImportedItems(account, { ...(after ? { afterItemId: after } : {}), ...(limit !== undefined ? { limit } : {}) })) });
  },
};

const setReferencesTool: Tool = {
  name: "pro_set_item_references",
  title: "Set references on imported listings",
  description: "Attaches your own reference (SKU) to imported listings, by Vinted id. Needs confirm: true.",
  annotations: WRITE,
  inputSchema: {
    type: "object",
    properties: {
      account_id: accountProp,
      items: { type: "array", items: { type: "object", properties: { id: { type: "string" }, reference: { type: "string" } }, required: ["id", "reference"] } },
      confirm: confirmProp,
    },
    required: ["items"],
    additionalProperties: false,
  },
  async handler(args) {
    const account = await getProAccount(optString(args, "account_id"));
    const raw = requireObjects(args, "items");
    const items = raw.map((entry, i) => {
      const id = typeof entry.id === "string" ? entry.id : "";
      const reference = typeof entry.reference === "string" ? entry.reference.trim() : "";
      if (!id || !reference) throw new ArgumentError(`items[${i}] needs "id" and "reference".`);
      return { id, reference };
    });
    if (optBoolean(args, "confirm") !== true) {
      return preview(account, "set_item_references", { items: items.length, sample: items.slice(0, 5) });
    }
    return jsonResult({ account: account.id, ...summariseWrite(await setItemReferences(account, items)) });
  },
};

// ---------------------------------------------------------------- orders

const listOrdersTool: Tool = {
  name: "pro_list_orders",
  title: "List orders",
  description: "Lists orders with a cursor (after_id = the last order id of the previous page). Shown as Vinted sent it.",
  annotations: READ,
  inputSchema: {
    type: "object",
    properties: { account_id: accountProp, after_id: { type: "string", description: "Cursor: last order id seen." } },
    additionalProperties: false,
  },
  async handler(args) {
    const account = await getProAccount(optString(args, "account_id"));
    const after = optString(args, "after_id");
    return jsonResult({ account: account.id, data: capped(await listOrders(account, after ? { afterId: after } : {})) });
  },
};

const getOrderTool: Tool = {
  name: "pro_get_order",
  title: "Get an order",
  description: "One order with its items.",
  annotations: READ,
  inputSchema: {
    type: "object",
    properties: { account_id: accountProp, order_id: { type: "string" } },
    required: ["order_id"],
    additionalProperties: false,
  },
  async handler(args) {
    const account = await getProAccount(optString(args, "account_id"));
    return jsonResult({ account: account.id, order: capped(await getOrder(account, requireString(args, "order_id"))) });
  },
};

const getShipmentTool: Tool = {
  name: "pro_get_shipment",
  title: "Get an order's shipment",
  description: "Shipment data of an order (carrier, tracking).",
  annotations: READ,
  inputSchema: {
    type: "object",
    properties: { account_id: accountProp, order_id: { type: "string" } },
    required: ["order_id"],
    additionalProperties: false,
  },
  async handler(args) {
    const account = await getProAccount(optString(args, "account_id"));
    return jsonResult({ account: account.id, shipment: capped(await getShipment(account, requireString(args, "order_id"))) });
  },
};

const MAX_LABEL_BYTES = 3_000_000;

const getLabelTool: Tool = {
  name: "pro_get_label",
  title: "Get a shipping label (PDF)",
  description:
    "Downloads the shipping label of an order as a PDF, returned base64 encoded. The label exists only after the SHIPMENT_LABEL_CREATED webhook; before that Vinted answers 404. It is already paid for.",
  annotations: READ,
  inputSchema: {
    type: "object",
    properties: { account_id: accountProp, order_id: { type: "string" } },
    required: ["order_id"],
    additionalProperties: false,
  },
  async handler(args) {
    const account = await getProAccount(optString(args, "account_id"));
    const orderId = requireString(args, "order_id");
    const label = await getLabel(account, orderId);
    if (label.bytes.length > MAX_LABEL_BYTES) {
      throw new ProError(`The label is ${label.bytes.length} bytes, more than a tool answer can carry; download it from the panel.`, "unexpected");
    }
    return jsonResult({
      account: account.id,
      orderId,
      contentType: label.contentType,
      bytes: label.bytes.length,
      filename: `label_${orderId}.pdf`,
      base64: Buffer.from(label.bytes).toString("base64"),
    });
  },
};

const cancelOrderTool: Tool = {
  name: "pro_cancel_order",
  title: "Cancel an order",
  description: `Cancels an order. A reason is required (at most ${CANCEL_REASON_MAX} characters). Asynchronous: a failure arrives by webhook (CANCEL_ORDER_FAILURE). Needs confirm: true.`,
  annotations: WRITE,
  inputSchema: {
    type: "object",
    properties: {
      account_id: accountProp,
      order_id: { type: "string" },
      reason: { type: "string", description: `Why the order is cancelled, up to ${CANCEL_REASON_MAX} characters.` },
      confirm: confirmProp,
    },
    required: ["order_id", "reason"],
    additionalProperties: false,
  },
  async handler(args) {
    const account = await getProAccount(optString(args, "account_id"));
    const orderId = requireString(args, "order_id");
    const reason = requireString(args, "reason");
    if ([...reason].length > CANCEL_REASON_MAX) throw new ArgumentError(`"reason" may be at most ${CANCEL_REASON_MAX} characters.`);
    if (optBoolean(args, "confirm") !== true) return preview(account, "cancel_order", { orderId, reason });
    const answer = await cancelOrder(account, orderId, reason);
    return jsonResult({ cancelled: "requested", account: account.id, orderId, answer: capped(answer, 5_000), asynchronous: "A failure arrives by webhook (CANCEL_ORDER_FAILURE)." });
  },
};

const relistOrdersTool: Tool = {
  name: "pro_relist_orders",
  title: "Relist items from cancelled orders",
  description: "Puts the items of cancelled orders back on sale. Needs confirm: true.",
  annotations: WRITE,
  inputSchema: {
    type: "object",
    properties: {
      account_id: accountProp,
      order_ids: { type: "array", items: { type: "string" } },
      confirm: confirmProp,
    },
    required: ["order_ids"],
    additionalProperties: false,
  },
  async handler(args) {
    const account = await getProAccount(optString(args, "account_id"));
    const ids = requireStrings(args, "order_ids");
    if (optBoolean(args, "confirm") !== true) return preview(account, "relist_orders", { orderIds: ids });
    return jsonResult({ relisted: "requested", account: account.id, answer: capped(await relistOrders(account, ids), 5_000) });
  },
};

// ---------------------------------------------------------------- calibration and audit

const rawGetTool: Tool = {
  name: "pro_raw_get",
  title: "Signed GET, raw answer",
  description:
    "Sends one signed GET to a Vinted Pro path (/api/v1/... or /api/v2/...) and returns the status, content type and body as Vinted sent them, errors included. For looking at the real shape of an answer when a field or parameter name is uncertain. Reads only; cannot change anything.",
  annotations: READ,
  inputSchema: {
    type: "object",
    properties: {
      account_id: accountProp,
      path: { type: "string", description: "e.g. /api/v1/orders" },
      query: { type: "object", description: "Query parameters, e.g. {\"after-id\": \"123\"}.", additionalProperties: { type: ["string", "number", "boolean"] } },
    },
    required: ["path"],
    additionalProperties: false,
  },
  async handler(args) {
    const account = await getProAccount(optString(args, "account_id"));
    const path = assertProPath(requireString(args, "path"));
    if (path.startsWith("/dev/")) throw new ProInputError("Only /api/ paths can be read.");
    const query: Record<string, string | number | boolean> = {};
    const given = args.query;
    if (given !== undefined) {
      if (typeof given !== "object" || given === null || Array.isArray(given)) throw new ArgumentError(`"query" must be an object.`);
      for (const [k, v] of Object.entries(given)) {
        if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") throw new ArgumentError(`query.${k} must be a string, number or boolean.`);
        query[k] = v;
      }
    }
    const raw = await getProClient().raw(account, "GET", path, { query, once: true });
    const text = Buffer.from(raw.bytes).toString("utf8");
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      data = undefined;
    }
    return jsonResult({
      account: account.id,
      status: raw.status,
      contentType: raw.contentType,
      ...(data !== undefined ? { json: capped(data) } : { text: cleanSnippet(text, [account.accessKey, account.signingKey], 400) }),
    });
  },
};

const listActionsTool: Tool = {
  name: "pro_list_actions",
  title: "What was sent to Vinted Pro",
  description: "The last writes this server sent to Vinted Pro for an account (kind, count, outcome). No request data is kept.",
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: { type: "object", properties: { account_id: accountProp }, additionalProperties: false },
  async handler(args) {
    const account = await getProAccount(optString(args, "account_id"));
    return jsonResult({ account: account.id, actions: await getProActions(account.id) });
  },
};

export const proTools: Tool[] = [
  listAccountsTool,
  diagnoseProTool,
  removeAccountTool,
  getOntologyTool,
  findCategoryTool,
  priceSuggestionTool,
  listItemsTool,
  itemStatusTool,
  validateItemsTool,
  createItemsTool,
  updateItemsTool,
  deleteItemsTool,
  importedItemsTool,
  setReferencesTool,
  listOrdersTool,
  getOrderTool,
  getShipmentTool,
  getLabelTool,
  cancelOrderTool,
  relistOrdersTool,
  rawGetTool,
  listActionsTool,
];
