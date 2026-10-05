import { randomBytes } from "node:crypto";
import { getStore, keys } from "../../store/index.js";
import { resolveAccount } from "../../vinted/accounts.js";
import { updateListing, uploadPhoto } from "../../vinted/actions.js";
import { getSellerItems } from "../../vinted/search.js";
import { jsonResult } from "../protocol.js";
import { accountProp, confirmProp, DESTRUCTIVE, preview } from "./actions.js";
import {
  ArgumentError,
  optBoolean,
  optNumber,
  optString,
  requireString,
  type Tool,
} from "./types.js";

/** Selling side: photos, the account's own listings, edits and saved drafts. */

const MAX_PHOTO_BYTES = 3_500_000;
const MAX_DRAFT_JSON = 20_000;

const uploadPhotoTool: Tool = {
  name: "upload_photo",
  title: "Upload a listing photo",
  description:
    "Uploads one photo to the account and returns its photo id, which publish_listing takes in photo_ids. The panel shrinks photos in the browser first; keep each under about 3 MB.",
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  inputSchema: {
    type: "object",
    properties: {
      account_id: accountProp,
      data_base64: { type: "string", description: "Image bytes, base64 encoded." },
      mime: { type: "string", enum: ["image/jpeg", "image/png"] },
    },
    required: ["data_base64", "mime"],
    additionalProperties: false,
  },
  async handler(args) {
    const account = await resolveAccount(optString(args, "account_id"));
    const mime = requireString(args, "mime");
    if (mime !== "image/jpeg" && mime !== "image/png") {
      throw new ArgumentError('"mime" must be image/jpeg or image/png.');
    }
    const bytes = Buffer.from(requireString(args, "data_base64"), "base64");
    if (bytes.length === 0) throw new ArgumentError("The image is empty.");
    if (bytes.length > MAX_PHOTO_BYTES) {
      throw new ArgumentError(`The image is ${bytes.length} bytes; the limit is ${MAX_PHOTO_BYTES}.`);
    }
    const outcome = await uploadPhoto(account, bytes, mime);
    const response = outcome.response as { id?: number; photo?: { id?: number } };
    const photoId = response.id ?? response.photo?.id;
    if (photoId === undefined) {
      throw new ArgumentError(
        "Vinted accepted the upload but returned no photo id - the photo endpoint's response shape has probably changed.",
      );
    }
    return jsonResult({ photoId, account: account.id });
  },
};

const listMyListings: Tool = {
  name: "list_my_listings",
  title: "List my listings",
  description:
    "Lists the account's own active listings with price, views and favourites. Needs the account's user id (run test_account once if it is unknown).",
  annotations: { readOnlyHint: true, openWorldHint: true },
  inputSchema: {
    type: "object",
    properties: { account_id: accountProp },
    additionalProperties: false,
  },
  async handler(args) {
    const account = await resolveAccount(optString(args, "account_id"));
    if (account.userId === undefined) {
      throw new ArgumentError(
        `The user id of "${account.id}" is unknown. Run test_account for it first.`,
      );
    }
    const items = await getSellerItems(String(account.userId), { account, perPage: 50 });
    return jsonResult({ account: account.id, count: items.length, items });
  },
};

const updateListingTool: Tool = {
  name: "update_listing",
  title: "Edit a listing",
  description:
    "Changes the title, description or price of one of the account's own listings. Only the fields you pass change. Needs confirm: true.",
  annotations: DESTRUCTIVE,
  inputSchema: {
    type: "object",
    properties: {
      account_id: accountProp,
      item_id: { type: "string", description: "Id of your own listing." },
      title: { type: "string" },
      description: { type: "string" },
      price: { type: "number" },
      confirm: confirmProp,
    },
    required: ["item_id"],
    additionalProperties: false,
  },
  async handler(args) {
    const account = await resolveAccount(optString(args, "account_id"));
    const itemId = requireString(args, "item_id");
    const edit = {
      ...(optString(args, "title") !== undefined ? { title: optString(args, "title")! } : {}),
      ...(optString(args, "description") !== undefined
        ? { description: optString(args, "description")! }
        : {}),
      ...(optNumber(args, "price") !== undefined ? { price: optNumber(args, "price")! } : {}),
    };
    if (Object.keys(edit).length === 0) {
      throw new ArgumentError("Pass at least one of title, description, price.");
    }
    if (edit.price !== undefined && edit.price <= 0) {
      throw new ArgumentError("Price must be positive.");
    }
    if (optBoolean(args, "confirm") !== true) {
      return preview(account, "update", { itemId, changes: edit });
    }
    await updateListing(account, itemId, edit);
    return jsonResult({ sent: true, action: "update", itemId, changes: edit, account: account.id });
  },
};

interface DraftRecord {
  id: string;
  updatedAt: string;
  data: Record<string, unknown>;
}

const saveDraft: Tool = {
  name: "save_draft",
  title: "Save a listing draft",
  description:
    "Saves a listing draft (any JSON object of form fields) so it can be finished later. Pass id to overwrite an existing draft. Nothing is sent to Vinted.",
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  inputSchema: {
    type: "object",
    properties: {
      account_id: accountProp,
      id: { type: "string", description: "Existing draft id to overwrite." },
      draft: { type: "object", description: "The form fields." },
    },
    required: ["draft"],
    additionalProperties: false,
  },
  async handler(args) {
    const account = await resolveAccount(optString(args, "account_id"));
    const data = args.draft;
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new ArgumentError('"draft" must be an object.');
    }
    if (JSON.stringify(data).length > MAX_DRAFT_JSON) {
      throw new ArgumentError("The draft is too large.");
    }
    const store = getStore();
    const id = optString(args, "id") ?? randomBytes(6).toString("hex");
    const record: DraftRecord = {
      id,
      updatedAt: new Date().toISOString(),
      data: data as Record<string, unknown>,
    };
    await store.set(keys.draft(account.id, id), record);
    await store.sadd(keys.drafts(account.id), id);
    return jsonResult({ saved: true, id, account: account.id });
  },
};

const listDrafts: Tool = {
  name: "list_drafts",
  title: "List listing drafts",
  description: "Returns the saved listing drafts of an account, newest first.",
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    type: "object",
    properties: { account_id: accountProp },
    additionalProperties: false,
  },
  async handler(args) {
    const account = await resolveAccount(optString(args, "account_id"));
    const store = getStore();
    const drafts: DraftRecord[] = [];
    for (const id of await store.smembers(keys.drafts(account.id))) {
      const rec = await store.get<DraftRecord>(keys.draft(account.id, id));
      if (rec) drafts.push(rec);
    }
    drafts.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return jsonResult({ account: account.id, drafts });
  },
};

const deleteDraft: Tool = {
  name: "delete_draft",
  title: "Delete a listing draft",
  description: "Deletes a saved draft. Local only; nothing on Vinted is touched.",
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  inputSchema: {
    type: "object",
    properties: { account_id: accountProp, id: { type: "string" } },
    required: ["id"],
    additionalProperties: false,
  },
  async handler(args) {
    const account = await resolveAccount(optString(args, "account_id"));
    const id = requireString(args, "id");
    const store = getStore();
    await store.del(keys.draft(account.id, id));
    await store.srem(keys.drafts(account.id), id);
    return jsonResult({ deleted: id, account: account.id });
  },
};

export const sellingTools: Tool[] = [
  uploadPhotoTool,
  listMyListings,
  updateListingTool,
  saveDraft,
  listDrafts,
  deleteDraft,
];
