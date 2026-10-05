/**
 * Errors of the Vinted Pro integration.
 *
 * A message never contains a request header, a request body or a key: it is
 * safe to show in the panel, return from a tool and write to a log.
 */

export type ProErrorKind =
  /** The integration is not set up (no account, bad token, bad host). */
  | "config"
  /** 401: wrong access key, wrong signature, stale timestamp, other environment. */
  | "auth"
  /** 403: not on the allowlist, or a market the API does not serve. */
  | "forbidden"
  | "not_found"
  /** 400/422: the request was understood and refused. */
  | "validation"
  | "rate_limited"
  | "server"
  | "network"
  | "unexpected";

export class ProError extends Error {
  constructor(
    message: string,
    readonly kind: ProErrorKind,
    readonly status: number | null = null,
    /** The `error` code of Vinted's JSON body, e.g. ORDER_NOT_FOUND. */
    readonly code: string | null = null,
    /** The parsed error body, for validation problems. Never request data. */
    readonly details: unknown = undefined,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = "ProError";
  }
}

/** Bad input from the caller (token, label, ids); the caller can fix it. */
export class ProInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProInputError";
  }
}
