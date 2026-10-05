/**
 * Which hosts the server may talk to on an account's behalf.
 *
 * Several tools take a `domain` argument, and the client attaches the account's
 * session cookie to every request it makes. Text that reaches a model through
 * the MCP endpoint (buyers' messages, listing descriptions) is written by
 * strangers, so a tool call must never be able to point an authenticated
 * request at a host that is not a Vinted marketplace.
 */

const VINTED_HOST = /^(www\.)?vinted\.[a-z]{2,3}(\.[a-z]{2})?$/i;

export function isVintedHost(domain: string): boolean {
  return VINTED_HOST.test(domain.trim());
}

export class HostError extends Error {
  constructor(domain: string) {
    super(
      `"${domain}" is not a Vinted marketplace host (expected e.g. www.vinted.pl). Requests are only sent to Vinted.`,
    );
    this.name = "HostError";
  }
}

/** Returns the host in canonical form or throws. */
export function assertVintedHost(domain: string): string {
  const clean = domain.trim().toLowerCase();
  if (!isVintedHost(clean)) throw new HostError(domain);
  return clean;
}
