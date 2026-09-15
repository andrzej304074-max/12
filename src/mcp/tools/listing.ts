import { jsonResult } from "../protocol.js";
import { optNumber, optString, requireString, type Tool } from "./types.js";

/**
 * Listing preparation.
 *
 * These tools compose and check a draft locally - they never reach Vinted.
 * Publishing is a separate concern and is not implemented here; see
 * docs/ACTIONS.md.
 */

/**
 * Field limits Vinted enforces on the listing form. They are not published as
 * a contract, so treat them as close-enough guard rails rather than gospel:
 * the point is to catch a 400-character title before it reaches the form.
 */
export const LIMITS = {
  titleMax: 100,
  descriptionMax: 3000,
  descriptionMin: 20,
} as const;

export interface DraftInput {
  title: string;
  description: string;
  price: number | undefined;
  currency: string | undefined;
  brand: string | undefined;
  size: string | undefined;
  condition: string | undefined;
  catalogId: number | undefined;
  brandId: number | undefined;
  photoCount: number | undefined;
}

export interface DraftIssue {
  field: string;
  severity: "blocker" | "warning";
  message: string;
}

/** Checks a draft against the form's constraints and common-sense gaps. */
export function checkDraft(draft: DraftInput): DraftIssue[] {
  const issues: DraftIssue[] = [];

  if (draft.title.length > LIMITS.titleMax) {
    issues.push({
      field: "title",
      severity: "blocker",
      message: `Title is ${draft.title.length} characters; Vinted allows about ${LIMITS.titleMax}.`,
    });
  }
  if (draft.description.length > LIMITS.descriptionMax) {
    issues.push({
      field: "description",
      severity: "blocker",
      message: `Description is ${draft.description.length} characters; Vinted allows about ${LIMITS.descriptionMax}.`,
    });
  }
  if (draft.description.length < LIMITS.descriptionMin) {
    issues.push({
      field: "description",
      severity: "warning",
      message:
        "Description is very short. Buyers ask fewer questions when measurements and flaws are stated up front.",
    });
  }
  if (draft.price === undefined || draft.price <= 0) {
    issues.push({
      field: "price",
      severity: "blocker",
      message: "A positive price is required.",
    });
  }
  if (draft.catalogId === undefined) {
    issues.push({
      field: "catalog_id",
      severity: "blocker",
      message: "A category is required - resolve one with find_category.",
    });
  }
  if (draft.brandId === undefined && !draft.brand) {
    issues.push({
      field: "brand",
      severity: "warning",
      message:
        "No brand set. Branded items surface in far more searches - resolve one with find_brand.",
    });
  }
  if (!draft.size) {
    issues.push({
      field: "size",
      severity: "warning",
      message: "No size set. Clothing without a size gets filtered out of most searches.",
    });
  }
  if (!draft.condition) {
    issues.push({
      field: "condition",
      severity: "blocker",
      message: "A condition is required.",
    });
  }
  if (draft.photoCount !== undefined && draft.photoCount < 1) {
    issues.push({
      field: "photos",
      severity: "blocker",
      message: "At least one photo is required.",
    });
  } else if (draft.photoCount !== undefined && draft.photoCount < 3) {
    issues.push({
      field: "photos",
      severity: "warning",
      message: "Fewer than three photos. Listings with 4+ photos sell noticeably faster.",
    });
  }
  return issues;
}

function readDraft(args: Record<string, unknown>): DraftInput {
  return {
    title: requireString(args, "title"),
    description: requireString(args, "description"),
    price: optNumber(args, "price"),
    currency: optString(args, "currency"),
    brand: optString(args, "brand"),
    size: optString(args, "size"),
    condition: optString(args, "condition"),
    catalogId: optNumber(args, "catalog_id"),
    brandId: optNumber(args, "brand_id"),
    photoCount: optNumber(args, "photo_count"),
  };
}

const draftSchema = {
  type: "object",
  properties: {
    title: { type: "string", description: "Listing title." },
    description: { type: "string", description: "Listing description." },
    price: { type: "number", description: "Asking price." },
    currency: { type: "string", description: "Currency code, e.g. PLN." },
    brand: { type: "string", description: "Brand name." },
    brand_id: { type: "number", description: "Vinted brand id (find_brand)." },
    size: { type: "string", description: "Size label." },
    condition: {
      type: "string",
      description: "Condition, e.g. 'new with tags', 'very good'.",
    },
    catalog_id: {
      type: "number",
      description: "Vinted category id (find_category).",
    },
    photo_count: { type: "number", description: "How many photos you have." },
  },
  required: ["title", "description"],
  additionalProperties: false,
} as const;

const draftListing: Tool = {
  name: "draft_listing",
  title: "Draft a listing",
  description:
    "Assembles a listing draft and checks it against Vinted's field limits and the gaps that cost sales (no size, too few photos, thin description). Runs entirely locally and never contacts Vinted. Returns the draft plus a blockers/warnings report.",
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: draftSchema as unknown as Record<string, unknown>,
  async handler(args) {
    const draft = readDraft(args);
    const issues = checkDraft(draft);
    const blockers = issues.filter((i) => i.severity === "blocker");
    return jsonResult({
      draft,
      ready: blockers.length === 0,
      blockers,
      warnings: issues.filter((i) => i.severity === "warning"),
      next:
        blockers.length === 0
          ? "Draft looks complete. Publishing is not performed by this server - paste it into Vinted's form to review and submit."
          : "Resolve the blockers, then re-run draft_listing.",
    });
  },
};

const validateListing: Tool = {
  name: "validate_listing",
  title: "Validate a listing draft",
  description:
    "Checks a draft against Vinted's field limits and required fields without contacting Vinted and without publishing anything. This is the safe end-to-end check: it can never post.",
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: draftSchema as unknown as Record<string, unknown>,
  async handler(args) {
    const draft = readDraft(args);
    const issues = checkDraft(draft);
    return jsonResult({
      valid: issues.every((i) => i.severity !== "blocker"),
      issues,
      limits: LIMITS,
      note: "Validation is local. Nothing was sent to Vinted and nothing was published.",
    });
  },
};

export const listingTools: Tool[] = [draftListing, validateListing];
