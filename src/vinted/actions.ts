import type { VintedAccount } from "../config.js";
import {
  checkBudget,
  consumeBudget,
  LimitError,
  recordAction,
  tripBreaker,
  type ActionKind,
} from "../monitor/safety.js";
import { getClient, RefusalError } from "./client.js";
import { endpoints } from "./endpoints.js";

/**
 * Actions that change something on Vinted, performed as one account.
 *
 * Every action goes through `perform`, which enforces the account's limits
 * before sending, counts it afterwards, records it in the action log, and
 * trips the circuit breaker when Vinted refuses. Request bodies follow the
 * UNVERIFIED shapes in ./endpoints.ts - check them in DevTools first.
 */

export interface ActionOutcome<T = unknown> {
  kind: ActionKind;
  itemId: string | null;
  response: T;
}

async function perform<T>(
  account: VintedAccount,
  kind: ActionKind,
  itemId: string | null,
  automatic: boolean,
  run: () => Promise<T>,
): Promise<ActionOutcome<T>> {
  const verdict = await checkBudget(account.id, kind, { automatic });
  if (!verdict.ok) throw new LimitError(verdict.message);

  try {
    const response = await run();
    await consumeBudget(account.id, kind, { automatic });
    await recordAction(account.id, {
      at: new Date().toISOString(),
      kind,
      itemId,
      automatic,
      ok: true,
      detail: "sent",
    });
    return { kind, itemId, response };
  } catch (err) {
    const message = (err as Error).message;
    if (err instanceof RefusalError) {
      await tripBreaker(account.id, `${kind} refused: ${message}`);
    }
    await recordAction(account.id, {
      at: new Date().toISOString(),
      kind,
      itemId,
      automatic,
      ok: false,
      detail: message,
    });
    throw err;
  }
}

export interface ActOptions {
  /** True when the monitor triggers the action rather than a person. */
  automatic?: boolean;
}

export function likeItem(
  account: VintedAccount,
  itemId: string,
  { automatic = false }: ActOptions = {},
) {
  return perform(account, "like", itemId, automatic, () =>
    getClient().send("POST", endpoints.favouriteToggle(), {
      account,
      body: { type: "item", item_id: Number(itemId) },
    }),
  );
}

export async function sendOffer(
  account: VintedAccount,
  itemId: string,
  price: number,
  currency: string | null,
  { automatic = false }: ActOptions = {},
) {
  if (!Number.isFinite(price) || price <= 0) {
    throw new LimitError("Offer price must be a positive number.");
  }
  return perform(account, "offer", itemId, automatic, () =>
    getClient().send("POST", endpoints.offers(), {
      account,
      body: {
        item_id: Number(itemId),
        price: price.toFixed(2),
        ...(currency ? { currency } : {}),
      },
    }),
  );
}

export function sendMessage(account: VintedAccount, itemId: string, text: string) {
  return perform(account, "message", itemId, false, async () => {
    const conversation = await getClient().send<{
      conversation?: { id?: number };
      id?: number;
    }>("POST", endpoints.itemConversation(itemId), { account });
    const conversationId = conversation.conversation?.id ?? conversation.id;
    if (conversationId === undefined) {
      throw new Error(
        "Vinted did not return a conversation id for this item; the conversation endpoint shape has probably changed.",
      );
    }
    return getClient().send("POST", endpoints.conversationMessage(conversationId), {
      account,
      body: { body: text },
    });
  });
}

export interface PublishPayload {
  title: string;
  description: string;
  price: number;
  currency: string | null;
  catalogId: number;
  brandId: number | null;
  brand: string | null;
  size: string | null;
  condition: string | null;
  /** Ids of photos already uploaded to Vinted. Upload is not handled here. */
  photoIds: number[];
}

export function publishListing(account: VintedAccount, payload: PublishPayload) {
  return perform(account, "publish", null, false, () =>
    getClient().send<{ item?: { id?: number; url?: string } }>(
      "POST",
      endpoints.createItem(),
      {
        account,
        body: {
          item: {
            title: payload.title,
            description: payload.description,
            price: payload.price.toFixed(2),
            ...(payload.currency ? { currency: payload.currency } : {}),
            catalog_id: payload.catalogId,
            ...(payload.brandId !== null ? { brand_id: payload.brandId } : {}),
            ...(payload.brand ? { brand: payload.brand } : {}),
            ...(payload.size ? { size: payload.size } : {}),
            ...(payload.condition ? { status: payload.condition } : {}),
            assigned_photos: payload.photoIds.map((id) => ({ id })),
          },
        },
      },
    ),
  );
}

export function replyToConversation(
  account: VintedAccount,
  conversationId: string,
  text: string,
) {
  return perform(account, "message", null, false, () =>
    getClient().send("POST", endpoints.conversationMessage(conversationId), {
      account,
      body: { body: text },
    }),
  );
}

export function respondToOffer(
  account: VintedAccount,
  conversationId: string,
  offerId: string,
  accept: boolean,
) {
  return perform(account, "respond", null, false, () =>
    getClient().send("POST", endpoints.respondOffer(conversationId, offerId, accept), {
      account,
    }),
  );
}

/** Uploads one photo; returns Vinted's photo id for use in publish_listing. */
export function uploadPhoto(account: VintedAccount, bytes: Uint8Array, mime: string) {
  return perform(account, "upload", null, false, async () => {
    const form = new FormData();
    form.set("photo[type]", "item");
    form.set("photo[temp_uuid]", crypto.randomUUID());
    form.set(
      "photo[file]",
      new Blob([Buffer.from(bytes)], { type: mime }),
      mime === "image/png" ? "photo.png" : "photo.jpg",
    );
    return getClient().send<{ id?: number; photo?: { id?: number } }>(
      "POST",
      endpoints.photos(),
      { account, form },
    );
  });
}

export interface ListingEdit {
  title?: string;
  description?: string;
  price?: number;
}

export function updateListing(account: VintedAccount, itemId: string, edit: ListingEdit) {
  const item: Record<string, unknown> = {};
  if (edit.title !== undefined) item.title = edit.title;
  if (edit.description !== undefined) item.description = edit.description;
  if (edit.price !== undefined) item.price = edit.price.toFixed(2);
  return perform(account, "update", itemId, false, () =>
    getClient().send("PUT", endpoints.updateItem(itemId), { account, body: { item } }),
  );
}

export function deleteListing(account: VintedAccount, itemId: string) {
  return perform(account, "delete", itemId, false, () =>
    getClient().send("DELETE", endpoints.deleteItem(itemId), { account }),
  );
}
