import { getConfig } from "../config.js";
import { log } from "../log.js";
import { getStore, keys, thisHour, today } from "../store/index.js";

/**
 * Guard rails for actions that touch the marketplace.
 *
 * Nothing here hides what the client is. The point is the opposite: keep an
 * account's activity at the pace of a moderate, ordinary user, and stop on its
 * own the moment Vinted pushes back, instead of grinding on.
 *
 *   - limits: per-day and per-hour ceilings, adjustable per account at runtime
 *   - activity window: automatic actions only run inside chosen local hours
 *   - circuit breaker: a refusal pauses automation for the account
 */

export interface Limits {
  likesPerDay: number;
  offersPerDay: number;
  actionsPerHour: number;
  activeHours: { start: number; end: number };
  autopauseHours: number;
  discountPct: number;
}

export type LimitOverrides = Partial<Limits>;

export type ActionKind = "like" | "offer" | "message" | "publish" | "delete";

export class LimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LimitError";
  }
}

export function defaultLimits(): Limits {
  const cfg = getConfig();
  return {
    likesPerDay: cfg.maxLikesPerDay,
    offersPerDay: cfg.maxOffersPerDay,
    actionsPerHour: cfg.maxActionsPerHour,
    activeHours: cfg.activeHours,
    autopauseHours: cfg.autopauseHours,
    discountPct: cfg.offerDiscountPct,
  };
}

export async function getOverrides(accountId: string): Promise<LimitOverrides> {
  return (await getStore().get<LimitOverrides>(keys.limits(accountId))) ?? {};
}

/** Effective limits for an account: environment defaults plus overrides. */
export async function getLimits(accountId: string): Promise<Limits> {
  return { ...defaultLimits(), ...(await getOverrides(accountId)) };
}

function wholeNonNegative(name: string, value: unknown, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new LimitError(`"${name}" must be a whole number of 0 or more.`);
  }
  if (value > max) {
    throw new LimitError(`"${name}" must be at most ${max}.`);
  }
  return value;
}

/** Validates a partial update. Throws LimitError on any bad value. */
export function validateOverrides(patch: Record<string, unknown>): LimitOverrides {
  const out: LimitOverrides = {};
  if (patch.likesPerDay !== undefined) {
    out.likesPerDay = wholeNonNegative("likes_per_day", patch.likesPerDay, 10_000);
  }
  if (patch.offersPerDay !== undefined) {
    out.offersPerDay = wholeNonNegative("offers_per_day", patch.offersPerDay, 10_000);
  }
  if (patch.actionsPerHour !== undefined) {
    out.actionsPerHour = wholeNonNegative(
      "actions_per_hour",
      patch.actionsPerHour,
      1_000,
    );
  }
  if (patch.autopauseHours !== undefined) {
    out.autopauseHours = wholeNonNegative(
      "autopause_hours",
      patch.autopauseHours,
      24 * 30,
    );
  }
  if (patch.discountPct !== undefined) {
    out.discountPct = wholeNonNegative("discount_pct", patch.discountPct, 90);
  }
  if (patch.activeHours !== undefined) {
    const hours = patch.activeHours as { start?: unknown; end?: unknown };
    out.activeHours = {
      start: wholeNonNegative("active_hours start", hours.start, 24),
      end: wholeNonNegative("active_hours end", hours.end, 24),
    };
  }
  return out;
}

/** Merges validated overrides into what is stored for the account. */
export async function setLimits(
  accountId: string,
  patch: Record<string, unknown>,
): Promise<Limits> {
  const valid = validateOverrides(patch);
  const merged = { ...(await getOverrides(accountId)), ...valid };
  await getStore().set(keys.limits(accountId), merged);
  return { ...defaultLimits(), ...merged };
}

/** Drops all overrides, going back to the environment defaults. */
export async function resetLimits(accountId: string): Promise<Limits> {
  await getStore().del(keys.limits(accountId));
  return defaultLimits();
}

/** Current hour (0-23) in the configured time zone. */
export function localHour(now: Date = new Date(), timeZone = getConfig().timeZone): number {
  const hour = new Intl.DateTimeFormat("en-GB", {
    hour: "numeric",
    hourCycle: "h23",
    timeZone,
  }).format(now);
  return Number(hour) % 24;
}

/**
 * True when `hour` falls in [start, end). A window that wraps midnight
 * (e.g. 22-6) is supported; start === end means "always".
 */
export function inActiveWindow(
  hour: number,
  window: { start: number; end: number },
): boolean {
  const { start, end } = window;
  if (start === end) return true;
  if (start < end) return hour >= start && hour < end;
  return hour >= start || hour < end;
}

export interface Autopause {
  until: string;
  reason: string;
  since: string;
}

export async function getAutopause(accountId: string): Promise<Autopause | null> {
  const pause = await getStore().get<Autopause>(keys.autopause(accountId));
  if (!pause) return null;
  if (new Date(pause.until).getTime() <= Date.now()) {
    await getStore().del(keys.autopause(accountId));
    return null;
  }
  return pause;
}

/** Trips the circuit breaker: automatic actions stop for the account. */
export async function tripBreaker(accountId: string, reason: string): Promise<Autopause> {
  const limits = await getLimits(accountId);
  const hours = Math.max(limits.autopauseHours, 1);
  const now = Date.now();
  const pause: Autopause = {
    since: new Date(now).toISOString(),
    until: new Date(now + hours * 3_600_000).toISOString(),
    reason,
  };
  await getStore().set(keys.autopause(accountId), pause, hours * 3600);
  log.warn("automation paused", { accountId, reason, until: pause.until });
  return pause;
}

export async function resumeAutomation(accountId: string): Promise<void> {
  await getStore().del(keys.autopause(accountId));
}

function dailyKey(accountId: string, kind: ActionKind, now: Date): string | null {
  if (kind === "like") return keys.likeCount(accountId, today(now));
  if (kind === "offer") return keys.offerCount(accountId, today(now));
  return null;
}

function dailyLimit(limits: Limits, kind: ActionKind): number | null {
  if (kind === "like") return limits.likesPerDay;
  if (kind === "offer") return limits.offersPerDay;
  return null;
}

export interface Usage {
  likesToday: number;
  offersToday: number;
  automaticThisHour: number;
}

export async function getUsage(accountId: string, now = new Date()): Promise<Usage> {
  const store = getStore();
  return {
    likesToday: (await store.get<number>(keys.likeCount(accountId, today(now)))) ?? 0,
    offersToday: (await store.get<number>(keys.offerCount(accountId, today(now)))) ?? 0,
    automaticThisHour:
      (await store.get<number>(keys.hourCount(accountId, thisHour(now)))) ?? 0,
  };
}

export type BudgetVerdict =
  | { ok: true }
  | {
      ok: false;
      /** "paused" | "window" | "hourly" | "daily" | "disabled" */
      reason: "paused" | "window" | "hourly" | "daily" | "disabled";
      message: string;
    };

/**
 * Decides whether an action may run now. Manual (confirmed) actions are held
 * to the daily caps only; automatic ones also to the pause, the activity
 * window and the hourly cap.
 */
export async function checkBudget(
  accountId: string,
  kind: ActionKind,
  { automatic, now = new Date() }: { automatic: boolean; now?: Date },
): Promise<BudgetVerdict> {
  const limits = await getLimits(accountId);
  const usage = await getUsage(accountId, now);

  const cap = dailyLimit(limits, kind);
  if (cap === 0) {
    return {
      ok: false,
      reason: "disabled",
      message: `${kind} actions are disabled for account "${accountId}" (limit set to 0).`,
    };
  }

  if (automatic) {
    const pause = await getAutopause(accountId);
    if (pause) {
      return {
        ok: false,
        reason: "paused",
        message: `Automation is paused until ${pause.until}: ${pause.reason}`,
      };
    }
    const hour = localHour(now);
    if (!inActiveWindow(hour, limits.activeHours)) {
      return {
        ok: false,
        reason: "window",
        message: `Outside the activity window ${limits.activeHours.start}-${limits.activeHours.end} (now ${hour}:00).`,
      };
    }
    if (limits.actionsPerHour === 0) {
      return { ok: false, reason: "disabled", message: "Automatic actions are set to 0 per hour." };
    }
    if (usage.automaticThisHour >= limits.actionsPerHour) {
      return {
        ok: false,
        reason: "hourly",
        message: `Hourly limit of ${limits.actionsPerHour} automatic actions reached.`,
      };
    }
  }

  if (cap !== null) {
    const used = kind === "like" ? usage.likesToday : usage.offersToday;
    if (used >= cap) {
      return {
        ok: false,
        reason: "daily",
        message: `Daily ${kind} limit of ${cap} reached for account "${accountId}".`,
      };
    }
  }
  return { ok: true };
}

/** Records a completed action against the counters. */
export async function consumeBudget(
  accountId: string,
  kind: ActionKind,
  { automatic, now = new Date() }: { automatic: boolean; now?: Date },
): Promise<void> {
  const store = getStore();
  const key = dailyKey(accountId, kind, now);
  if (key) await store.incr(key, 60 * 60 * 26);
  if (automatic) await store.incr(keys.hourCount(accountId, thisHour(now)), 60 * 60 * 2);
}

export interface ActionLogEntry {
  at: string;
  kind: ActionKind;
  itemId: string | null;
  automatic: boolean;
  ok: boolean;
  detail: string;
}

const LOG_LENGTH = 50;

export async function recordAction(accountId: string, entry: ActionLogEntry): Promise<void> {
  const store = getStore();
  const current = (await store.get<ActionLogEntry[]>(keys.actionLog(accountId))) ?? [];
  const next = [entry, ...current].slice(0, LOG_LENGTH);
  await store.set(keys.actionLog(accountId), next, 60 * 60 * 24 * 14);
}

export async function getActionLog(accountId: string): Promise<ActionLogEntry[]> {
  return (await getStore().get<ActionLogEntry[]>(keys.actionLog(accountId))) ?? [];
}
