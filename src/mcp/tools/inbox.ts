import { getStore, keys } from "../../store/index.js";
import { listAccounts, resolveAccount } from "../../vinted/accounts.js";
import { replyToConversation, respondToOffer } from "../../vinted/actions.js";
import {
  getConversation,
  listConversations,
  type ConversationSummary,
} from "../../vinted/inbox.js";
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

/** Conversations with buyers and sellers, plus quick-reply templates. */

const listConversationsTool: Tool = {
  name: "list_conversations",
  title: "List conversations",
  description:
    "Lists conversations from the inbox of one account, or of all connected accounts at once with all_accounts: true, newest first. Each entry has the other person, the item, the last message and whether it is unread.",
  annotations: { readOnlyHint: true, openWorldHint: true },
  inputSchema: {
    type: "object",
    properties: {
      account_id: accountProp,
      all_accounts: { type: "boolean", description: "Combine the inboxes of every connected account." },
      unread_only: { type: "boolean", description: "Only unread conversations." },
      page: { type: "number", description: "1-based page." },
    },
    additionalProperties: false,
  },
  async handler(args) {
    const page = optNumber(args, "page") ?? 1;
    const unreadOnly = optBoolean(args, "unread_only") ?? false;
    const accounts = optBoolean(args, "all_accounts")
      ? (await listAccounts()).filter((a) => a.status !== "needs_login")
      : [await resolveAccount(optString(args, "account_id"))];

    const conversations: ConversationSummary[] = [];
    const errors: { accountId: string; message: string }[] = [];
    for (const account of accounts) {
      try {
        conversations.push(...(await listConversations(account, page)));
      } catch (err) {
        errors.push({ accountId: account.id, message: (err as Error).message });
      }
    }
    const shown = (unreadOnly ? conversations.filter((c) => c.unread) : conversations).sort(
      (a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""),
    );
    return jsonResult({
      count: shown.length,
      unread: conversations.filter((c) => c.unread).length,
      conversations: shown,
      errors,
    });
  },
};

const getConversationTool: Tool = {
  name: "get_conversation",
  title: "Open a conversation",
  description:
    "Returns one conversation with all its messages. Offers inside it show their price and status, and can be answered with respond_to_offer.",
  annotations: { readOnlyHint: true, openWorldHint: true },
  inputSchema: {
    type: "object",
    properties: {
      account_id: accountProp,
      conversation_id: { type: "string", description: "Conversation id from list_conversations." },
    },
    required: ["conversation_id"],
    additionalProperties: false,
  },
  async handler(args) {
    const account = await resolveAccount(optString(args, "account_id"));
    const detail = await getConversation(account, requireString(args, "conversation_id"));
    return jsonResult(detail ?? { conversation: null, message: "Conversation not found." });
  },
};

const replyTool: Tool = {
  name: "reply_conversation",
  title: "Reply in a conversation",
  description: "Sends a message in an existing conversation. Needs confirm: true.",
  annotations: DESTRUCTIVE,
  inputSchema: {
    type: "object",
    properties: {
      account_id: accountProp,
      conversation_id: { type: "string" },
      text: { type: "string", description: "Message text (max 2000 characters)." },
      confirm: confirmProp,
    },
    required: ["conversation_id", "text"],
    additionalProperties: false,
  },
  async handler(args) {
    const account = await resolveAccount(optString(args, "account_id"));
    const conversationId = requireString(args, "conversation_id");
    const text = requireString(args, "text");
    if (text.length > 2000) throw new ArgumentError("Message is longer than 2000 characters.");
    if (optBoolean(args, "confirm") !== true) {
      return preview(account, "message", { conversationId, text });
    }
    await replyToConversation(account, conversationId, text);
    return jsonResult({ sent: true, action: "reply", conversationId, account: account.id });
  },
};

const respondOfferTool: Tool = {
  name: "respond_to_offer",
  title: "Accept or reject an offer",
  description:
    "Accepts or rejects a price offer a buyer made inside a conversation. Needs confirm: true.",
  annotations: DESTRUCTIVE,
  inputSchema: {
    type: "object",
    properties: {
      account_id: accountProp,
      conversation_id: { type: "string" },
      offer_id: { type: "string", description: "Offer id shown in get_conversation." },
      accept: { type: "boolean", description: "true to accept, false to reject." },
      confirm: confirmProp,
    },
    required: ["conversation_id", "offer_id", "accept"],
    additionalProperties: false,
  },
  async handler(args) {
    const account = await resolveAccount(optString(args, "account_id"));
    const conversationId = requireString(args, "conversation_id");
    const offerId = requireString(args, "offer_id");
    const accept = optBoolean(args, "accept");
    if (accept === undefined) throw new ArgumentError('"accept" is required and must be a boolean.');
    if (optBoolean(args, "confirm") !== true) {
      return preview(account, "respond", { conversationId, offerId, decision: accept ? "accept" : "reject" });
    }
    await respondToOffer(account, conversationId, offerId, accept);
    return jsonResult({
      sent: true,
      action: accept ? "accept" : "reject",
      conversationId,
      offerId,
      account: account.id,
    });
  },
};

const DEFAULT_TEMPLATES = [
  "Dzień dobry, czy przedmiot jest nadal aktualny?",
  "Dziękuję za wiadomość. Przedmiot jest dostępny.",
  "Cześć, mogę zejść trochę z ceny przy szybkim zakupie.",
];

const getTemplates: Tool = {
  name: "get_reply_templates",
  title: "Get quick-reply templates",
  description: "Returns the saved quick-reply templates used in the panel's inbox.",
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  async handler() {
    const saved = await getStore().get<string[]>(keys.templates());
    return jsonResult({ templates: saved ?? DEFAULT_TEMPLATES, isDefault: saved === null });
  },
};

const setTemplates: Tool = {
  name: "set_reply_templates",
  title: "Save quick-reply templates",
  description: "Replaces the saved quick-reply templates (at most 20, 500 characters each).",
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  inputSchema: {
    type: "object",
    properties: { templates: { type: "array", items: { type: "string" } } },
    required: ["templates"],
    additionalProperties: false,
  },
  async handler(args) {
    const raw = args.templates;
    if (!Array.isArray(raw) || raw.some((t) => typeof t !== "string")) {
      throw new ArgumentError('"templates" must be an array of strings.');
    }
    const templates = raw.map((t) => (t as string).trim()).filter(Boolean);
    if (templates.length > 20) throw new ArgumentError("At most 20 templates.");
    if (templates.some((t) => t.length > 500)) {
      throw new ArgumentError("A template is longer than 500 characters.");
    }
    await getStore().set(keys.templates(), templates);
    return jsonResult({ templates });
  },
};

export const inboxTools: Tool[] = [
  listConversationsTool,
  getConversationTool,
  replyTool,
  respondOfferTool,
  getTemplates,
  setTemplates,
];
