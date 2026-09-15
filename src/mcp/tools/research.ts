import { getConfig } from "../../config.js";
import { estimateFromComps } from "../../vinted/pricing.js";
import {
  findCatalogPath,
  getCatalogs,
  getItem,
  getSeller,
  searchItems,
  suggest,
} from "../../vinted/search.js";
import { jsonResult } from "../protocol.js";
import {
  optNumber,
  optNumberArray,
  optString,
  requireString,
  type Tool,
} from "./types.js";

/** Read-only research tools: comparable listings, pricing, taxonomy lookup. */

const READ_ONLY = { readOnlyHint: true, openWorldHint: true } as const;

const searchSimilarItems: Tool = {
  name: "search_similar_items",
  title: "Search comparable listings",
  description:
    "Searches Vinted's public catalog for listings comparable to an item. Use it to see what similar pieces are being asked for before pricing your own. Returns normalised listings with price, brand, size, condition and URL.",
  annotations: READ_ONLY,
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "Free-text description, e.g. 'Nike Air Max 90 white 42' or 'Zara wool coat M'.",
      },
      brand_ids: {
        type: "array",
        items: { type: "number" },
        description: "Restrict to these Vinted brand ids (see find_brand).",
      },
      catalog_ids: {
        type: "array",
        items: { type: "number" },
        description: "Restrict to these category ids (see find_category).",
      },
      price_from: { type: "number", description: "Minimum price filter." },
      price_to: { type: "number", description: "Maximum price filter." },
      currency: { type: "string", description: "Currency code, e.g. PLN." },
      order: {
        type: "string",
        enum: ["relevance", "newest_first", "price_low_to_high", "price_high_to_low"],
        description: "Result ordering. Defaults to relevance.",
      },
      per_page: {
        type: "number",
        description: "Results per page, up to 96. Defaults to 24.",
      },
      page: { type: "number", description: "1-based page number." },
      domain: {
        type: "string",
        description:
          "Marketplace host to query, e.g. www.vinted.pl. Defaults to VINTED_DOMAIN.",
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
  async handler(args) {
    const params = {
      query: requireString(args, "query"),
      brandIds: optNumberArray(args, "brand_ids"),
      catalogIds: optNumberArray(args, "catalog_ids"),
      priceFrom: optNumber(args, "price_from"),
      priceTo: optNumber(args, "price_to"),
      currency: optString(args, "currency"),
      order: optString(args, "order"),
      perPage: optNumber(args, "per_page"),
      page: optNumber(args, "page"),
      domain: optString(args, "domain"),
    };
    const items = await searchItems(params);
    return jsonResult({
      query: params.query,
      count: items.length,
      items,
    });
  },
};

const estimatePrice: Tool = {
  name: "estimate_price",
  title: "Estimate a listing price",
  description:
    "Gathers comparable listings and returns the full asking-price distribution, three price points (quick sale / recommended / ambitious) and a confidence rating. Note that Vinted publishes asking prices, not completed sale prices, so this describes what sellers want, not what buyers paid.",
  annotations: READ_ONLY,
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Description of the item being priced.",
      },
      brand_ids: { type: "array", items: { type: "number" } },
      catalog_ids: { type: "array", items: { type: "number" } },
      currency: { type: "string" },
      sample_size: {
        type: "number",
        description: "How many comparable listings to pull. Defaults to 60.",
      },
      domain: { type: "string" },
    },
    required: ["query"],
    additionalProperties: false,
  },
  async handler(args) {
    const query = requireString(args, "query");
    const sampleSize = Math.min(optNumber(args, "sample_size") ?? 60, 96);
    const comps = await searchItems({
      query,
      brandIds: optNumberArray(args, "brand_ids"),
      catalogIds: optNumberArray(args, "catalog_ids"),
      currency: optString(args, "currency"),
      perPage: sampleSize,
      order: "relevance",
      domain: optString(args, "domain"),
    });
    const estimate = estimateFromComps(comps);
    if (!estimate) {
      return jsonResult({
        query,
        estimate: null,
        message:
          "No comparable listings with a usable price were found. Try a broader query or drop the filters.",
      });
    }
    return jsonResult({
      query,
      compsConsidered: comps.length,
      ...estimate,
      sampleUrls: comps.slice(0, 8).map((c) => c.url),
    });
  },
};

const findCategory: Tool = {
  name: "find_category",
  title: "Find a Vinted category",
  description:
    "Resolves a free-text category name to Vinted catalog ids, returning the full path so you can tell similar leaves apart.",
  annotations: READ_ONLY,
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Category name to look for." },
      limit: { type: "number", description: "Maximum matches. Defaults to 15." },
      domain: { type: "string" },
    },
    required: ["query"],
    additionalProperties: false,
  },
  async handler(args) {
    const query = requireString(args, "query");
    const limit = optNumber(args, "limit") ?? 15;
    const tree = await getCatalogs(optString(args, "domain"));
    const matches = findCatalogPath(tree, query).slice(0, limit);
    return jsonResult({
      query,
      matches: matches.map((m) => ({ id: m.id, path: m.path.join(" > ") })),
    });
  },
};

const findBrand: Tool = {
  name: "find_brand",
  title: "Find a Vinted brand",
  description:
    "Resolves a brand name to Vinted brand ids using the site's own search suggestions.",
  annotations: READ_ONLY,
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Brand name to look for." },
      domain: { type: "string" },
    },
    required: ["query"],
    additionalProperties: false,
  },
  async handler(args) {
    const query = requireString(args, "query");
    const suggestions = await suggest(query, optString(args, "domain"));
    return jsonResult({ query, suggestions });
  },
};

const getItemTool: Tool = {
  name: "get_item",
  title: "Get a listing",
  description: "Fetches one Vinted listing by id.",
  annotations: READ_ONLY,
  inputSchema: {
    type: "object",
    properties: {
      item_id: { type: "string", description: "Numeric Vinted item id." },
      domain: { type: "string" },
    },
    required: ["item_id"],
    additionalProperties: false,
  },
  async handler(args) {
    const itemId = requireString(args, "item_id");
    const item = await getItem(itemId, optString(args, "domain"));
    return jsonResult(item ?? { item: null, message: "Listing not found." });
  },
};

const getSellerTool: Tool = {
  name: "get_seller",
  title: "Get a seller profile",
  description:
    "Fetches a seller's public profile: item count, followers and feedback reputation. Useful for judging whether a seller is worth watching.",
  annotations: READ_ONLY,
  inputSchema: {
    type: "object",
    properties: {
      seller_id: { type: "string", description: "Numeric Vinted user id." },
      domain: { type: "string" },
    },
    required: ["seller_id"],
    additionalProperties: false,
  },
  async handler(args) {
    const sellerId = requireString(args, "seller_id");
    const domain = optString(args, "domain") ?? getConfig().defaultDomain;
    const seller = await getSeller(sellerId, domain);
    return jsonResult(
      seller
        ? { ...seller, profileUrl: `https://${domain}/member/${sellerId}` }
        : { user: null, message: "Seller not found." },
    );
  },
};

export const researchTools: Tool[] = [
  searchSimilarItems,
  estimatePrice,
  findCategory,
  findBrand,
  getItemTool,
  getSellerTool,
];
