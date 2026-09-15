/** Shapes this server reads out of Vinted responses. Deliberately partial. */

export interface VintedPhoto {
  url?: string;
  full_size_url?: string;
}

export interface VintedItem {
  id: number;
  title: string;
  /** Vinted returns money as a nested object on modern endpoints. */
  price?: { amount?: string; currency_code?: string } | string;
  currency?: string;
  brand_title?: string;
  size_title?: string;
  status?: string;
  url?: string;
  favourite_count?: number;
  view_count?: number;
  created_at_ts?: string;
  photo?: VintedPhoto;
  photos?: VintedPhoto[];
  user?: { id?: number; login?: string };
  catalog_id?: number;
  brand_id?: number;
  is_closed?: boolean;
  is_hidden?: boolean;
}

export interface VintedUser {
  id: number;
  login?: string;
  item_count?: number;
  followers_count?: number;
  feedback_reputation?: number;
  city?: string;
  country_title_local?: string;
}

/** A listing reduced to the fields the tools actually surface. */
export interface NormalisedItem {
  id: string;
  title: string;
  price: number | null;
  currency: string | null;
  brand: string | null;
  size: string | null;
  condition: string | null;
  url: string | null;
  favourites: number | null;
  sellerId: string | null;
  sellerLogin: string | null;
  photoUrl: string | null;
  createdAt: string | null;
}

/** Reads Vinted's several money encodings into a plain number. */
export function parsePrice(price: VintedItem["price"]): {
  amount: number | null;
  currency: string | null;
} {
  if (price === undefined || price === null) {
    return { amount: null, currency: null };
  }
  if (typeof price === "string") {
    const parsed = Number(price);
    return { amount: Number.isFinite(parsed) ? parsed : null, currency: null };
  }
  const amount = price.amount !== undefined ? Number(price.amount) : NaN;
  return {
    amount: Number.isFinite(amount) ? amount : null,
    currency: price.currency_code ?? null,
  };
}

export function normaliseItem(
  item: VintedItem,
  domain: string,
): NormalisedItem {
  const { amount, currency } = parsePrice(item.price);
  const photo =
    item.photo?.full_size_url ??
    item.photo?.url ??
    item.photos?.[0]?.full_size_url ??
    item.photos?.[0]?.url ??
    null;
  return {
    id: String(item.id),
    title: item.title ?? "",
    price: amount,
    currency: currency ?? item.currency ?? null,
    brand: item.brand_title ?? null,
    size: item.size_title ?? null,
    condition: item.status ?? null,
    url: item.url ?? `https://${domain}/items/${item.id}`,
    favourites: item.favourite_count ?? null,
    sellerId: item.user?.id !== undefined ? String(item.user.id) : null,
    sellerLogin: item.user?.login ?? null,
    photoUrl: photo,
    createdAt: item.created_at_ts ?? null,
  };
}
