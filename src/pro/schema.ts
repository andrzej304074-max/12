import type { CategoryInfo } from "./ontology.js";
import { safeId } from "./hosts.js";

/**
 * What the integration assumes about request and response shapes.
 *
 * Everything the documentation marks as unconfirmed is a constant here, so the
 * fix after reading api.yml (or after the first answer from the sandbox) is a
 * one-line change and not a hunt. `pro_raw_get` exists to look at the real
 * thing without changing code.
 */

/** [ok] Items per create / update request; also used for delete and validate. */
export const MAX_BATCH = 100;

/** [?] The documentation shows `after-id` in one client and `after_id` in another. */
export const ORDERS_CURSOR_PARAM = "after-id";
/** [prob] */
export const ITEMS_CURSOR_PARAM = "after_item_id";
export const ITEMS_LIMIT_PARAM = "limit";

/** [prob] Longest cancellation reason Vinted accepts. */
export const CANCEL_REASON_MAX = 100;

/** [prob] Text limits from the documentation. Advisory: Vinted decides. */
export const TEXT_LIMITS = {
  title: { min: 5, max: 100 },
  description: { min: 5, max: 2000 },
} as const;

/**
 * [?] The price field: the documentation's example sends a number (39.0) but a
 * client may need a string or an object with a currency. Change it here.
 */
export function formatPrice(price: number): number {
  return Math.round(price * 100) / 100;
}

export interface ItemProblem {
  index: number;
  field: string;
  /**
   * A stable code the panel turns into its own wording. The ones Vinted also
   * uses (TITLE_LENGTH, CATALOG_NOT_LEAF, BRAND_REQUIRED, ...) keep its names.
   */
  code: string;
  message: string;
  /** "error" blocks sending; "warning" is advice Vinted may overrule. */
  level: "error" | "warning";
}

export interface CheckedItem {
  /** The payload to send, or null when there are blocking errors. */
  payload: Record<string, unknown> | null;
  problems: ItemProblem[];
  /** Fields dropped because the category disables them. */
  removedFields: string[];
}

const problem = (index: number, field: string, code: string, message: string, level: ItemProblem["level"]): ItemProblem => ({
  index,
  field,
  code,
  message,
  level,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isWholeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function numeric(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

function checkText(
  item: Record<string, unknown>,
  field: "title" | "description",
  index: number,
  problems: ItemProblem[],
  required: boolean,
): void {
  const value = item[field];
  if (value === undefined && !required) return;
  if (typeof value !== "string" || value.trim() === "") {
    problems.push(problem(index, field, "TEXT_REQUIRED", `"${field}" is required and must be text.`, "error"));
    return;
  }
  const { min, max } = TEXT_LIMITS[field];
  const length = [...value.trim()].length;
  if (length < min || length > max) {
    problems.push(
      problem(
        index,
        field,
        field === "title" ? "TITLE_LENGTH" : "DESCRIPTION_LENGTH",
        `"${field}" is ${length} characters; the documentation gives ${min}-${max}.`,
        "warning",
      ),
    );
  }
}

function checkPhotos(item: Record<string, unknown>, index: number, problems: ItemProblem[], required: boolean): void {
  const value = item.photo_urls;
  if (value === undefined && !required) return;
  if (!Array.isArray(value) || value.length === 0 || !value.every((u) => typeof u === "string")) {
    problems.push(problem(index, "photo_urls", "PHOTOS_REQUIRED", `"photo_urls" must be a list of public photo addresses.`, "error"));
    return;
  }
  for (const raw of value as string[]) {
    let url: URL | null = null;
    try {
      url = new URL(raw);
    } catch {
      /* reported below */
    }
    if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) {
      problems.push(problem(index, "photo_urls", "PHOTO_URL_INVALID", `"${raw.slice(0, 80)}" is not an http(s) address.`, "error"));
    } else if (url.protocol === "http:") {
      problems.push(problem(index, "photo_urls", "PHOTO_NOT_HTTPS", `"${raw.slice(0, 80)}" is not https; Vinted fetches the photos itself, so they must be public and permanent.`, "warning"));
    }
  }
}

/**
 * Checks one item for creation. Structural problems (a missing or mistyped
 * required field) are errors; everything the documentation only describes
 * ("5-100 characters", "leaf category") is a warning, because Vinted is the one
 * that decides and a stale local rule must not stop a valid request.
 *
 * Unknown fields pass through untouched: the documentation is incomplete, and
 * the caller may know a field the integration does not.
 */
export function checkNewItem(
  raw: unknown,
  index: number,
  opts: { category?: CategoryInfo | null; draftByDefault: boolean },
): CheckedItem {
  const problems: ItemProblem[] = [];
  if (!isRecord(raw)) {
    return { payload: null, removedFields: [], problems: [problem(index, "(item)", "ITEM_NOT_OBJECT", "Each item must be an object.", "error")] };
  }
  const item: Record<string, unknown> = { ...raw };
  // A category can switch fields off ("disabled_fields"); those are neither
  // required nor sent.
  const disabled = new Set(opts.category?.disabledFields ?? []);

  checkText(item, "title", index, problems, true);
  checkText(item, "description", index, problems, true);
  checkPhotos(item, index, problems, true);

  const price = numeric(item.price);
  if (price === null || price <= 0) {
    problems.push(problem(index, "price", "PRICE_INVALID", `"price" must be a number above 0.`, "error"));
  }
  for (const field of ["catalog_id", "status_id", "package_size_id"] as const) {
    if (!isWholeNumber(item[field])) {
      problems.push(problem(index, field, "ID_REQUIRED", `"${field}" is required and must be an id from the ontology.`, "error"));
    }
  }
  if (!disabled.has("brand") && (typeof item.brand !== "string" || item.brand.trim() === "")) {
    problems.push(problem(index, "brand", "BRAND_REQUIRED", `"brand" is required and is plain text (not an id).`, "error"));
  }
  if (item.reference !== undefined && (typeof item.reference !== "string" || item.reference.trim() === "")) {
    problems.push(problem(index, "reference", "TEXT_REQUIRED", `"reference" must be text.`, "error"));
  }
  if (item.is_draft !== undefined && typeof item.is_draft !== "boolean") {
    problems.push(problem(index, "is_draft", "DRAFT_FLAG_INVALID", `"is_draft" must be true or false.`, "error"));
  }

  const removedFields: string[] = [];
  const category = opts.category;
  if (category) {
    if (!category.leaf) {
      problems.push(
        problem(
          index,
          "catalog_id",
          "CATALOG_NOT_LEAF",
          `Category ${category.id} ("${category.path.join(" › ")}") is not a leaf; Vinted accepts only leaf categories.`,
          "warning",
        ),
      );
    }
    for (const field of category.disabledFields) {
      if (field in item) {
        delete item[field];
        removedFields.push(field);
      }
    }
  }

  if (problems.some((p) => p.level === "error")) return { payload: null, problems, removedFields };

  item.price = formatPrice(price as number);
  item.title = (item.title as string).trim();
  item.description = (item.description as string).trim();
  if (typeof item.brand === "string") item.brand = item.brand.trim();
  if (item.is_draft === undefined && opts.draftByDefault) item.is_draft = true;
  return { payload: item, problems, removedFields };
}

/** Checks one item for an update: it needs the Vinted id and something to change. */
export function checkItemUpdate(raw: unknown, index: number): CheckedItem {
  const problems: ItemProblem[] = [];
  if (!isRecord(raw)) {
    return { payload: null, removedFields: [], problems: [problem(index, "(item)", "ITEM_NOT_OBJECT", "Each item must be an object.", "error")] };
  }
  const item: Record<string, unknown> = { ...raw };
  try {
    if (typeof item.id !== "string") throw new Error("missing");
    safeId(item.id, "id");
  } catch {
    problems.push(problem(index, "id", "UPDATE_ID_REQUIRED", `"id" is required: the Vinted id (UUID) of the item.`, "error"));
  }
  if (Object.keys(item).filter((k) => k !== "id").length === 0) {
    problems.push(problem(index, "(item)", "UPDATE_NOTHING", "Nothing to change besides the id.", "error"));
  }
  checkText(item, "title", index, problems, false);
  checkText(item, "description", index, problems, false);
  checkPhotos(item, index, problems, false);
  if (item.price !== undefined) {
    const price = numeric(item.price);
    if (price === null || price <= 0) {
      problems.push(problem(index, "price", "PRICE_INVALID", `"price" must be a number above 0.`, "error"));
    } else {
      item.price = formatPrice(price);
    }
  }
  if (problems.some((p) => p.level === "error")) return { payload: null, problems, removedFields: [] };
  return { payload: item, problems, removedFields: [] };
}

/** Splits a list into requests of at most MAX_BATCH. */
export function chunk<T>(list: T[], size = MAX_BATCH): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}
