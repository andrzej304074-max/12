import { getConfig, type VintedAccount } from "../config.js";
import { getClient } from "./client.js";
import { endpoints } from "./endpoints.js";
import {
  normaliseItem,
  type NormalisedItem,
  type VintedItem,
  type VintedUser,
} from "./types.js";

export interface SearchParams {
  query?: string;
  brandIds?: number[];
  catalogIds?: number[];
  sizeIds?: number[];
  /** Vinted status ids, e.g. new-with-tags. Passed through untouched. */
  statusIds?: number[];
  priceFrom?: number;
  priceTo?: number;
  currency?: string;
  /** "newest_first" | "price_low_to_high" | "price_high_to_low" | "relevance" */
  order?: string;
  page?: number;
  perPage?: number;
  domain?: string;
}

interface CatalogResponse {
  items?: VintedItem[];
}

/** Searches the public catalog. This is how comps are gathered. */
export async function searchItems(
  params: SearchParams,
): Promise<NormalisedItem[]> {
  const cfg = getConfig();
  const domain = params.domain ?? cfg.defaultDomain;
  const res = await getClient().get<CatalogResponse>(endpoints.catalogItems(), {
    domain,
    query: {
      search_text: params.query,
      brand_ids: params.brandIds?.join(","),
      catalog_ids: params.catalogIds?.join(","),
      size_ids: params.sizeIds?.join(","),
      status_ids: params.statusIds?.join(","),
      price_from: params.priceFrom,
      price_to: params.priceTo,
      currency: params.currency,
      order: params.order ?? "relevance",
      page: params.page ?? 1,
      per_page: Math.min(params.perPage ?? 24, 96),
    },
  });
  return (res.items ?? []).map((item) => normaliseItem(item, domain));
}

/** Fetches one listing. */
export async function getItem(
  itemId: string,
  domain?: string,
): Promise<NormalisedItem | null> {
  const cfg = getConfig();
  const host = domain ?? cfg.defaultDomain;
  const res = await getClient().get<{ item?: VintedItem }>(
    endpoints.item(itemId),
    { domain: host },
  );
  return res.item ? normaliseItem(res.item, host) : null;
}

/** Fetches a seller's public profile. */
export async function getSeller(
  userId: string,
  domain?: string,
): Promise<VintedUser | null> {
  const cfg = getConfig();
  const res = await getClient().get<{ user?: VintedUser }>(
    endpoints.user(userId),
    { domain: domain ?? cfg.defaultDomain },
  );
  return res.user ?? null;
}

/**
 * Lists a seller's items, newest first. The monitor calls this on each pass.
 * `account` is optional - passing one makes the read happen as that account,
 * which matters only for sellers who restrict visibility.
 */
export async function getSellerItems(
  userId: string,
  opts: { perPage?: number; domain?: string; account?: VintedAccount } = {},
): Promise<NormalisedItem[]> {
  const cfg = getConfig();
  const domain = opts.domain ?? opts.account?.domain ?? cfg.defaultDomain;
  const res = await getClient().get<{ items?: VintedItem[] }>(
    endpoints.userItems(userId),
    {
      domain,
      ...(opts.account ? { account: opts.account } : {}),
      query: {
        page: 1,
        per_page: opts.perPage ?? cfg.monitorPageSize,
        order: "newest_first",
      },
    },
  );
  return (res.items ?? []).map((item) => normaliseItem(item, domain));
}

export interface Suggestion {
  id: number | null;
  title: string;
  kind: string;
}

/**
 * Resolves free text to Vinted brands and categories via the suggestions
 * endpoint, which is what the site's own search box uses.
 */
export async function suggest(
  query: string,
  domain?: string,
): Promise<Suggestion[]> {
  const cfg = getConfig();
  const res = await getClient().get<{
    search_suggestions?: { id?: number; title?: string; type?: string }[];
  }>(endpoints.searchSuggestions(), {
    domain: domain ?? cfg.defaultDomain,
    query: { query },
  });
  return (res.search_suggestions ?? []).map((s) => ({
    id: s.id ?? null,
    title: s.title ?? "",
    kind: s.type ?? "unknown",
  }));
}

export interface CatalogNode {
  id: number;
  title: string;
  children: CatalogNode[];
}

/** Fetches the category tree. */
export async function getCatalogs(domain?: string): Promise<CatalogNode[]> {
  const cfg = getConfig();
  const res = await getClient().get<{ catalogs?: CatalogNode[] }>(
    endpoints.catalogs(),
    { domain: domain ?? cfg.defaultDomain },
  );
  return res.catalogs ?? [];
}

/** Depth-first search of the category tree for a text match. */
export function findCatalogPath(
  nodes: CatalogNode[],
  needle: string,
  trail: string[] = [],
): { id: number; path: string[] }[] {
  const lowered = needle.toLowerCase();
  const hits: { id: number; path: string[] }[] = [];
  for (const node of nodes) {
    const path = [...trail, node.title];
    if (node.title?.toLowerCase().includes(lowered)) {
      hits.push({ id: node.id, path });
    }
    if (node.children?.length) {
      hits.push(...findCatalogPath(node.children, needle, path));
    }
  }
  return hits;
}
