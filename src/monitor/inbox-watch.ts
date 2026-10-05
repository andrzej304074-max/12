import type { VintedAccount } from "../config.js";
import { getStore, keys } from "../store/index.js";
import { listConversations } from "../vinted/inbox.js";
import { notify } from "./notify.js";

/**
 * Looks for new unread messages and tells the webhook, once per message.
 *
 * The first run for an account only records what is already there, so
 * connecting an account does not trigger a notification for the whole inbox.
 */

export interface InboxCheck {
  newMessages: number;
  seededOnly: boolean;
  notified: boolean;
}

const MAX_TRACKED = 200;

export async function checkInbox(account: VintedAccount): Promise<InboxCheck> {
  const store = getStore();
  const conversations = await listConversations(account);
  const seeded = (await store.get<boolean>(keys.inboxSeeded(account.id))) === true;
  const seen = (await store.get<Record<string, string>>(keys.inboxSeen(account.id))) ?? {};

  const signature = (c: (typeof conversations)[number]) => `${c.updatedAt ?? ""}|${c.lastMessage}`;
  const fresh = conversations.filter((c) => c.unread && seen[c.id] !== signature(c));

  const next = { ...seen };
  for (const c of conversations) next[c.id] = signature(c);
  const trimmed = Object.fromEntries(Object.entries(next).slice(-MAX_TRACKED));
  await store.set(keys.inboxSeen(account.id), trimmed);
  await store.set(keys.inboxSeeded(account.id), true);

  if (!seeded) return { newMessages: 0, seededOnly: true, notified: false };
  if (fresh.length === 0) return { newMessages: 0, seededOnly: false, notified: false };

  const lines = fresh
    .slice(0, 10)
    .map((c) => `• ${c.withUser.login ?? "ktoś"}: ${c.lastMessage.slice(0, 120)}`);
  const notified = await notify(
    `Nowe wiadomości [${account.label}]: ${fresh.length}\n${lines.join("\n")}`,
  );
  return { newMessages: fresh.length, seededOnly: false, notified };
}
