/**
 * What an answer from Vinted actually was.
 *
 * The first version of the login treated any web page that mentioned
 * "captcha" or "datadome" as a bot-protection block. Ordinary Vinted pages
 * (including a plain 404) mention those words, so a wrong address looked
 * exactly like a block and told the user nothing true. These helpers sort
 * answers by evidence instead:
 *
 *   wall          a bot-protection challenge: a blocking status AND a marker
 *                 that only challenge pages carry
 *   rate_limited  HTTP 429
 *   rejected      HTTP 403/503 with nothing that identifies the sender
 *   not_api       a web page / redirect where JSON should have come back
 *   api           JSON, to be read by the caller (even when it is an error)
 *
 * Everything here is pure. The text it produces for display never contains
 * request data: callers pass the secrets they sent so they are scrubbed even
 * if a response echoed them back.
 */

export interface Evidence {
  status: number;
  contentType: string | null;
  server: string | null;
  /** Where a redirect points, without its query string. */
  location: string | null;
  /** Signs of a bot-protection challenge, e.g. "header:x-datadome". */
  markers: string[];
  /** Informational only - these do NOT make an answer a block. */
  hints: string[];
  /** Cleaned start of the body: no markup, no addresses, no long tokens. */
  snippet: string;
}

export type Verdict = "api" | "wall" | "rate_limited" | "rejected" | "not_api";

/** Headers that challenge responses carry. */
const HEADER_MARKERS = ["x-datadome", "x-dd-b", "x-datadome-cid", "cf-mitigated", "x-amzn-waf-action"];

/** Strings that appear on challenge pages and not on ordinary ones. */
const BODY_MARKERS: [string, RegExp][] = [
  ["body:captcha-delivery.com", /captcha-delivery\.com/i],
  ["body:just-a-moment", /just a moment\.\.\./i],
  ["body:cloudflare-challenge", /cf-chl-|__cf_chl_|attention required!? ?\|? ?cloudflare|error code:? ?1020/i],
  ["body:perimeterx", /px-captcha|perimeterx/i],
];

/** Statuses a challenge is served with. 405 is what AWS WAF uses for XHR. */
const CHALLENGE_STATUSES = new Set([401, 403, 405, 429, 503]);

export function cleanSnippet(text: string, secrets: string[] = [], max = 200): string {
  let out = text
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ");
  for (const secret of secrets) {
    if (secret && secret.length >= 3) out = out.split(secret).join("[hidden]");
  }
  return out
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]")
    .replace(/[A-Za-z0-9_\-+/=]{24,}/g, "[...]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/** Cookie names only - never values. */
function cookieNames(setCookie: string | null): string[] {
  if (!setCookie) return [];
  return [...setCookie.matchAll(/(?:^|,\s*)([A-Za-z0-9_.-]+)=/g)].map((m) => m[1]!.toLowerCase());
}

export function collectEvidence(
  status: number,
  headers: Headers,
  text: string,
  secrets: string[] = [],
): Evidence {
  const markers: string[] = [];
  const hints: string[] = [];

  for (const name of HEADER_MARKERS) {
    if (headers.get(name) !== null) markers.push(`header:${name}`);
  }
  const server = headers.get("server");
  if (server && /datadome/i.test(server)) markers.push("header:server=datadome");
  for (const [name, pattern] of BODY_MARKERS) {
    if (pattern.test(text)) markers.push(name);
  }

  if (headers.get("cf-ray") !== null) hints.push("cloudflare in front (cf-ray)");
  if (cookieNames(headers.get("set-cookie")).includes("datadome")) hints.push("sets a datadome cookie");

  const location = headers.get("location");
  return {
    status,
    contentType: headers.get("content-type"),
    server,
    location: location ? location.split("?")[0]!.slice(0, 200) : null,
    markers: [...new Set(markers)],
    hints,
    snippet: cleanSnippet(text, secrets),
  };
}

export function classify(evidence: Evidence, isJson: boolean): Verdict {
  if (evidence.status === 429) return "rate_limited";
  if (evidence.markers.length > 0 && CHALLENGE_STATUSES.has(evidence.status)) return "wall";
  if (isJson) return "api";
  if (evidence.status === 403 || evidence.status === 503) return "rejected";
  return "not_api";
}

/** One line for error messages and logs. */
export function describeEvidence(e: Evidence): string {
  const parts = [`HTTP ${e.status}`];
  if (e.contentType) parts.push(e.contentType.split(";")[0]!);
  if (e.server) parts.push(`server ${e.server}`);
  if (e.location) parts.push(`redirects to ${e.location}`);
  let line = parts.join(", ");
  if (e.markers.length) line += `; bot-protection markers: ${e.markers.join(", ")}`;
  return line;
}

/** Short, secret-free outcome for the login log. */
export function outcomeFor(kind: string, e: Evidence): string {
  return `${kind} http=${e.status}${e.markers.length ? ` ${e.markers.join(",")}` : ""}`;
}
