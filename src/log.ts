/**
 * Structured logging that will not leak credentials into Vercel's log drain.
 */

const SECRET_KEYS =
  /^(access_?token|session_?cookie|authorization|cookie|token|password|secret|mcp_?auth_?token|cron_?secret)$/i;

/** Replaces secret-looking values anywhere in a structure with "[redacted]". */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[truncated]";
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      out[key] = SECRET_KEYS.test(key) ? "[redacted]" : redact(val, depth + 1);
    }
    return out;
  }
  return value;
}

function emit(level: "info" | "warn" | "error", msg: string, meta?: unknown) {
  const line = JSON.stringify({
    level,
    msg,
    ...(meta === undefined ? {} : { meta: redact(meta) }),
    at: new Date().toISOString(),
  });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const log = {
  info: (msg: string, meta?: unknown) => emit("info", msg, meta),
  warn: (msg: string, meta?: unknown) => emit("warn", msg, meta),
  error: (msg: string, meta?: unknown) => emit("error", msg, meta),
};
