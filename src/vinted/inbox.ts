import type { VintedAccount } from "../config.js";
import { getClient } from "./client.js";
import { endpoints } from "./endpoints.js";

/**
 * Conversations with buyers and sellers.
 *
 * The response shapes are UNVERIFIED, so the normalisers below read defensively
 * and fall back to empty values instead of throwing. If the inbox looks empty
 * or garbled after a deploy, compare a real response in DevTools with the
 * paths read here.
 */

export interface PartyInfo {
  id: string | null;
  login: string | null;
  avatarUrl: string | null;
}

export interface ConversationItem {
  id: string | null;
  title: string | null;
  photoUrl: string | null;
  price: number | null;
  currency: string | null;
}

export interface ConversationSummary {
  id: string;
  accountId: string;
  withUser: PartyInfo;
  item: ConversationItem | null;
  lastMessage: string;
  unread: boolean;
  updatedAt: string | null;
}

export interface ChatMessage {
  id: string;
  fromMe: boolean;
  kind: "text" | "offer" | "system";
  text: string;
  offer: {
    id: string | null;
    price: number | null;
    currency: string | null;
    status: string | null;
  } | null;
  createdAt: string | null;
}

export interface ConversationDetail {
  id: string;
  accountId: string;
  withUser: PartyInfo;
  item: ConversationItem | null;
  messages: ChatMessage[];
}

type Obj = Record<string, unknown>;

function obj(value: unknown): Obj {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Obj) : {};
}

function text(value: unknown): string | null {
  if (typeof value === "string" && value) return value;
  if (typeof value === "number") return String(value);
  return null;
}

function num(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && value !== null && value !== "" ? n : null;
}

function party(raw: unknown): PartyInfo {
  const user = obj(raw);
  return {
    id: text(user.id),
    login: text(user.login),
    avatarUrl: text(obj(user.photo).url) ?? text(user.avatar_url),
  };
}

function itemOf(raw: Obj): ConversationItem | null {
  const tx = obj(raw.transaction);
  const photos = Array.isArray(raw.item_photos) ? raw.item_photos : [];
  const id = text(tx.item_id) ?? text(raw.item_id);
  const title = text(tx.item_title) ?? text(raw.item_title);
  if (!id && !title) return null;
  const price = obj(tx.item_price);
  return {
    id,
    title,
    photoUrl: text(obj(photos[0]).url) ?? text(tx.item_photo_url),
    price: num(price.amount ?? tx.item_price),
    currency: text(price.currency_code),
  };
}

export function normaliseConversation(raw: unknown, accountId: string): ConversationSummary | null {
  const c = obj(raw);
  const id = text(c.id);
  if (!id) return null;
  return {
    id,
    accountId,
    withUser: party(c.opposite_user),
    item: itemOf(c),
    lastMessage: text(c.description) ?? text(c.last_message) ?? "",
    unread: c.unread === true,
    updatedAt: text(c.updated_at) ?? text(c.updated_at_ts),
  };
}

export function normaliseMessage(raw: unknown, myUserId: number | undefined): ChatMessage | null {
  const m = obj(raw);
  const id = text(m.id);
  if (!id) return null;
  const entity = obj(m.entity);
  const type = (text(m.entity_type) ?? "").toLowerCase();
  const kind: ChatMessage["kind"] = type.includes("offer")
    ? "offer"
    : /status|system|action|notification/.test(type)
      ? "system"
      : "text";
  const authorId = num(entity.user_id);
  const price = obj(entity.price);
  return {
    id,
    fromMe: myUserId !== undefined && authorId !== null && authorId === myUserId,
    kind,
    text: text(entity.body) ?? text(entity.title) ?? text(entity.status_title) ?? "",
    offer:
      kind === "offer"
        ? {
            id: text(entity.id) ?? text(entity.offer_id),
            price: num(price.amount ?? entity.price),
            currency: text(price.currency_code),
            status: text(entity.status_title) ?? text(entity.status),
          }
        : null,
    createdAt: text(m.created_at_ts) ?? text(m.created_at),
  };
}

export async function listConversations(
  account: VintedAccount,
  page = 1,
): Promise<ConversationSummary[]> {
  const res = await getClient().get<{ conversations?: unknown[] }>(endpoints.inbox(), {
    account,
    query: { page, per_page: 20 },
  });
  return (res.conversations ?? [])
    .map((raw) => normaliseConversation(raw, account.id))
    .filter((c): c is ConversationSummary => c !== null);
}

export async function getConversation(
  account: VintedAccount,
  conversationId: string,
): Promise<ConversationDetail | null> {
  const res = await getClient().get<{ conversation?: unknown }>(
    endpoints.conversation(conversationId),
    { account },
  );
  const raw = obj(res.conversation);
  const summary = normaliseConversation({ ...raw, id: raw.id ?? conversationId }, account.id);
  if (!summary) return null;
  const messages = (Array.isArray(raw.messages) ? raw.messages : [])
    .map((m) => normaliseMessage(m, account.userId))
    .filter((m): m is ChatMessage => m !== null);
  return {
    id: summary.id,
    accountId: account.id,
    withUser: summary.withUser,
    item: summary.item,
    messages,
  };
}
