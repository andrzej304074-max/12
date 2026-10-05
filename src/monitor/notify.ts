import { getConfig } from "../config.js";
import { log } from "../log.js";

/**
 * Optional webhook notification, so a person hears about a find within
 * minutes and can act on it from their phone.
 *
 * The payload carries both `content` (Discord) and `text` (Slack and most
 * generic receivers). A failing webhook is logged and never breaks a pass.
 */

export interface FindSummary {
  title: string;
  askingPrice: number | null;
  suggestedOfferPrice: number | null;
  currency: string | null;
  url: string | null;
  sellerLogin: string | null;
}

export function formatFinds(accountId: string, finds: FindSummary[]): string {
  const lines = finds.slice(0, 10).map((f) => {
    const cur = f.currency ?? "";
    const price = f.askingPrice !== null ? `${f.askingPrice} ${cur}`.trim() : "?";
    const offer =
      f.suggestedOfferPrice !== null ? ` → oferta ${f.suggestedOfferPrice} ${cur}`.trimEnd() : "";
    const seller = f.sellerLogin ? ` (${f.sellerLogin})` : "";
    return `• ${f.title}${seller}: ${price}${offer}\n  ${f.url ?? ""}`;
  });
  const more = finds.length > 10 ? `\n…i ${finds.length - 10} więcej` : "";
  return `Nowe przedmioty [${accountId}]: ${finds.length}\n${lines.join("\n")}${more}`;
}

export async function notify(text: string): Promise<boolean> {
  const url = getConfig().notifyWebhookUrl;
  if (!url) return false;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: text.slice(0, 1900), text }),
    });
    if (!res.ok) {
      log.warn("notify webhook rejected", { status: res.status });
      return false;
    }
    return true;
  } catch (err) {
    log.warn("notify webhook failed", { message: (err as Error).message });
    return false;
  }
}
