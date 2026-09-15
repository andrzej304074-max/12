/**
 * Every Vinted URL this server touches, in one place.
 *
 * Vinted's web API is not a published, versioned contract - paths and payload
 * shapes shift without notice. Keeping them here means a break is a one-line
 * fix instead of a hunt through the codebase. `diagnose_connection` probes
 * these and reports which ones still answer.
 *
 * Scope note: this module lists READ endpoints only. Actions that commit a
 * real transaction on the marketplace - publishing or deleting a listing,
 * submitting a price offer, messaging another member - are deliberately not
 * implemented here. See docs/ACTIONS.md for the reasoning and for what a
 * maintainer has to decide before adding them.
 */

export const endpoints = {
  /** Homepage - fetched only to pick up an anonymous session cookie. */
  home: () => `/`,

  /** Catalog search, the workhorse behind comps research. */
  catalogItems: () => `/api/v2/catalog/items`,

  /** Single listing detail. */
  item: (itemId: string | number) => `/api/v2/items/${itemId}`,

  /** Public profile of a seller. */
  user: (userId: string | number) => `/api/v2/users/${userId}`,

  /** A seller's listings, newest first - the monitor polls this. */
  userItems: (userId: string | number) => `/api/v2/users/${userId}/items`,

  /** Category tree. */
  catalogs: () => `/api/v2/catalogs`,

  /** Free-text suggestions, used to resolve brand and category names. */
  searchSuggestions: () => `/api/v2/search_suggestions`,

  /** Brand lookup. */
  brands: () => `/api/v2/brands`,
} as const;

/** Endpoints `diagnose_connection` probes, with a friendly label. */
export const probeTargets: { label: string; path: string }[] = [
  { label: "catalog search", path: endpoints.catalogItems() },
  { label: "category tree", path: endpoints.catalogs() },
  { label: "search suggestions", path: endpoints.searchSuggestions() },
];
