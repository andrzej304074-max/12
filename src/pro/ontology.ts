import { gunzipSync, gzipSync } from "node:zlib";
import { log } from "../log.js";
import { getStore, keys } from "../store/index.js";
import type { ProAccount } from "./accounts.js";
import { getProClient } from "./client.js";
import { proEndpoints } from "./endpoints.js";

/**
 * The ontology: every dictionary Vinted wants a listing built from - the
 * category tree, colours, package sizes, item conditions, size groups and
 * category attributes. `GET /api/v1/ontologies` returns all of it at once.
 *
 * The ids differ between markets and change over time, so they are never
 * written into code: the ontology is fetched, cached for a day and read from
 * there. Only the shape of the category tree is documented (nested `catalogs`,
 * with `size_group_ids`, `item_attribute_ids` and `disabled_fields`); the other
 * dictionaries are read by name with a few likely spellings and fall back to
 * "not found", which the panel turns into a plain number field.
 */

export interface CategoryInfo {
  id: number;
  title: string;
  /** Titles from the root down to this category. */
  path: string[];
  /** Only leaves may be used for a listing. */
  leaf: boolean;
  sizeGroupIds: number[];
  attributeIds: number[];
  /** Fields that must not be sent for this category. */
  disabledFields: string[];
}

export interface DictEntry {
  id: number;
  title: string;
}

interface Cached {
  fetchedAt: string;
  /** base64 of the gzipped JSON; the raw ontology is too big for a plain value. */
  gz: string;
}

const TTL_SECONDS = 24 * 60 * 60;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface LoadedOntology {
  raw: unknown;
  fetchedAt: string;
  fromCache: boolean;
}

/** When the cached ontology was fetched, or null if there is none. Cheap: nothing is unzipped. */
export async function ontologyFetchedAt(accountId: string): Promise<string | null> {
  return (await getStore().get<Cached>(keys.proOntology(accountId)))?.fetchedAt ?? null;
}

/** Reads the cached ontology, or fetches (and caches) it. */
export async function loadOntology(account: ProAccount, opts: { refresh?: boolean } = {}): Promise<LoadedOntology> {
  const store = getStore();
  if (!opts.refresh) {
    try {
      const cached = await store.get<Cached>(keys.proOntology(account.id));
      if (cached?.gz) {
        const raw = JSON.parse(gunzipSync(Buffer.from(cached.gz, "base64")).toString("utf8")) as unknown;
        return { raw, fetchedAt: cached.fetchedAt, fromCache: true };
      }
    } catch (err) {
      log.warn("ontology cache unreadable", { id: account.id, message: (err as Error).message });
    }
  }
  const { data } = await getProClient().json<unknown>(account, "GET", proEndpoints.ontologies());
  const fetchedAt = new Date().toISOString();
  try {
    const gz = gzipSync(Buffer.from(JSON.stringify(data), "utf8")).toString("base64");
    await store.set<Cached>(keys.proOntology(account.id), { fetchedAt, gz }, TTL_SECONDS);
  } catch (err) {
    // A store that refuses a large value must not make the ontology unusable.
    log.warn("ontology could not be cached", { id: account.id, message: (err as Error).message });
  }
  return { raw: data, fetchedAt, fromCache: false };
}

function numbers(value: unknown): number[] {
  return Array.isArray(value) ? value.map(Number).filter((n) => Number.isFinite(n)) : [];
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((s): s is string => typeof s === "string") : [];
}

/** Flattens the nested category tree. */
export function indexCategories(raw: unknown): CategoryInfo[] {
  const out: CategoryInfo[] = [];
  const visit = (nodes: unknown, path: string[]): void => {
    if (!Array.isArray(nodes)) return;
    for (const node of nodes) {
      if (!isRecord(node)) continue;
      const id = Number(node.id);
      if (!Number.isFinite(id)) continue;
      const title = typeof node.title === "string" ? node.title : String(id);
      const children = Array.isArray(node.catalogs) ? node.catalogs : [];
      const here = [...path, title];
      out.push({
        id,
        title,
        path: here,
        leaf: children.length === 0,
        sizeGroupIds: numbers(node.size_group_ids),
        attributeIds: numbers(node.item_attribute_ids),
        disabledFields: strings(node.disabled_fields),
      });
      visit(children, here);
    }
  };
  visit(Array.isArray(raw) ? raw : isRecord(raw) ? raw.catalogs : undefined, []);
  return out;
}

/** Lower case without diacritics; ł has no decomposition, so it is mapped by hand. */
const fold = (text: string) =>
  text
    .toLowerCase()
    .replace(/ł/g, "l")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

/** Categories whose path contains every word of the query, leaves first. */
export function findCategories(index: CategoryInfo[], query: string, limit = 10): CategoryInfo[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const scored: { cat: CategoryInfo; score: number }[] = [];
  for (const cat of index) {
    const haystack = fold(cat.path.join(" "));
    if (!words.every((w) => haystack.includes(w))) continue;
    const title = fold(cat.title);
    // Only a leaf can be used for a listing, so every leaf outranks every parent.
    let score = cat.leaf ? 100 : 0;
    if (title === fold(query).trim()) score += 20;
    else if (words.every((w) => title.includes(w))) score += 8;
    score -= cat.path.length * 0.1;
    scored.push({ cat, score });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit).map((s) => s.cat);
}

/** Reads a top-level list of `{id, title}` entries under one of several likely names. */
export function dictionary(raw: unknown, names: string[]): DictEntry[] | null {
  if (!isRecord(raw)) return null;
  const wanted = new Set(names.map((n) => n.toLowerCase()));
  for (const [key, value] of Object.entries(raw)) {
    if (!wanted.has(key.toLowerCase()) || !Array.isArray(value)) continue;
    const entries: DictEntry[] = [];
    for (const entry of value) {
      if (!isRecord(entry)) continue;
      const id = Number(entry.id);
      if (!Number.isFinite(id)) continue;
      const title = [entry.title, entry.name, entry.label, entry.code].find((t): t is string => typeof t === "string");
      entries.push({ id, title: title ?? String(id) });
    }
    return entries;
  }
  return null;
}

export const colorsOf = (raw: unknown) => dictionary(raw, ["colors", "colours"]);
export const packageSizesOf = (raw: unknown) => dictionary(raw, ["package_sizes", "packagesizes", "parcel_sizes"]);
export const conditionsOf = (raw: unknown) => dictionary(raw, ["statuses", "item_statuses", "conditions", "item_conditions"]);

/** Size groups with their sizes, as far as the shape allows reading them. */
export function sizeGroupsOf(raw: unknown): { id: number; sizes: DictEntry[] }[] | null {
  if (!isRecord(raw)) return null;
  const wanted = new Set(["size_groups", "sizegroups"]);
  for (const [key, value] of Object.entries(raw)) {
    if (!wanted.has(key.toLowerCase()) || !Array.isArray(value)) continue;
    const groups: { id: number; sizes: DictEntry[] }[] = [];
    for (const group of value) {
      if (!isRecord(group)) continue;
      const id = Number(group.id);
      if (!Number.isFinite(id)) continue;
      const sizes = dictionary({ sizes: group.sizes }, ["sizes"]) ?? [];
      groups.push({ id, sizes });
    }
    return groups;
  }
  return null;
}

/** Top-level keys with their kind and size: what to paste when a field is missing. */
export function describeOntology(raw: unknown): {
  topLevelKeys: { key: string; type: string; count: number | null }[];
  categories: { total: number; leaves: number };
} {
  const categories = indexCategories(raw);
  const keysOf = isRecord(raw)
    ? Object.entries(raw).map(([key, value]) => ({
        key,
        type: Array.isArray(value) ? "array" : value === null ? "null" : typeof value,
        count: Array.isArray(value) ? value.length : isRecord(value) ? Object.keys(value).length : null,
      }))
    : [{ key: "(root)", type: Array.isArray(raw) ? "array" : typeof raw, count: Array.isArray(raw) ? raw.length : null }];
  return {
    topLevelKeys: keysOf,
    categories: { total: categories.length, leaves: categories.filter((c) => c.leaf).length },
  };
}

/** A compact form for the panel's listing form: leaves with their path, and the dictionaries. */
export function compactOntology(raw: unknown) {
  const leaves = indexCategories(raw)
    .filter((c) => c.leaf)
    .map((c) => ({
      id: c.id,
      path: c.path.join(" › "),
      sizeGroupIds: c.sizeGroupIds,
      attributeIds: c.attributeIds,
      disabledFields: c.disabledFields,
    }));
  return {
    leaves,
    colors: colorsOf(raw),
    packageSizes: packageSizesOf(raw),
    conditions: conditionsOf(raw),
    sizeGroups: sizeGroupsOf(raw),
    keys: describeOntology(raw).topLevelKeys,
  };
}
