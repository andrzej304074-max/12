/**
 * Every Vinted URL this server touches, in one place.
 *
 * Vinted's web API is not a published, versioned contract - paths and payload
 * shapes shift without notice. Keeping them here means a break is a one-line
 * fix instead of a hunt through the codebase. `diagnose_connection` probes
 * these and reports which ones still answer.
 *
 * Write endpoints are marked UNVERIFIED: they could not be exercised from the
 * build environment. Before relying on one, perform the action once by hand
 * in a browser with DevTools open and compare the method, path and body with
 * what is written here. See docs/ACTIONS.md.
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

  /** Toggle a favourite ("like") on an item. POST { type, item_id }. UNVERIFIED */
  favouriteToggle: () => `/api/v2/user_favourites/toggle`,

  /** Create a listing. POST { item: {...} }. UNVERIFIED */
  createItem: () => `/api/v2/items`,

  /** Delete own listing. DELETE. UNVERIFIED */
  deleteItem: (itemId: string | number) => `/api/v2/items/${itemId}`,

  /** Open (or fetch) the conversation about an item. POST. UNVERIFIED */
  itemConversation: (itemId: string | number) =>
    `/api/v2/conversations/item/${itemId}`,

  /** Post a message into a conversation. POST { body }. UNVERIFIED */
  conversationMessage: (conversationId: string | number) =>
    `/api/v2/conversations/${conversationId}/messages`,

  /** Submit a price offer. POST { item_id, price, currency }. UNVERIFIED */
  offers: () => `/api/v2/offers`,

  /** Password login and token refresh. POST JSON. UNVERIFIED */
  oauthToken: () => `/oauth/token`,

  /** The signed-in user's own profile (id, login, avatar). GET. UNVERIFIED */
  currentUser: () => `/api/v2/users/current`,

  /** Conversation list. GET ?page&per_page. UNVERIFIED */
  inbox: () => `/api/v2/inbox`,

  /** One conversation with its messages. GET. UNVERIFIED */
  conversation: (conversationId: string | number) =>
    `/api/v2/conversations/${conversationId}`,

  /** Accept or reject an offer inside a conversation. POST. UNVERIFIED */
  respondOffer: (
    conversationId: string | number,
    offerId: string | number,
    accept: boolean,
  ) =>
    `/api/v2/conversations/${conversationId}/offers/${offerId}/${accept ? "accept" : "reject"}`,

  /** Upload a photo, multipart. POST. UNVERIFIED */
  photos: () => `/api/v2/photos`,

  /** Edit own listing. PUT { item: {...} }. UNVERIFIED */
  updateItem: (itemId: string | number) => `/api/v2/items/${itemId}`,
} as const;

/** Endpoints `diagnose_connection` probes, with a friendly label. */
export const probeTargets: { label: string; path: string }[] = [
  { label: "catalog search", path: endpoints.catalogItems() },
  { label: "category tree", path: endpoints.catalogs() },
  { label: "search suggestions", path: endpoints.searchSuggestions() },
];
