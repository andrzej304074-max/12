import { beforeEach, describe, expect, it } from "vitest";
import { parseActiveHours, resetConfigCache } from "../src/config.js";
import {
  checkBudget,
  consumeBudget,
  getAutopause,
  getLimits,
  inActiveWindow,
  localHour,
  resetLimits,
  resumeAutomation,
  setLimits,
  tripBreaker,
  validateOverrides,
} from "../src/monitor/safety.js";
import { resetStoreCache } from "../src/store/index.js";

beforeEach(() => {
  delete process.env.VERCEL;
  process.env.ACTIVE_HOURS = "0-0";
  process.env.MAX_LIKES_PER_DAY = "30";
  process.env.MAX_OFFERS_PER_DAY = "10";
  process.env.MAX_ACTIONS_PER_HOUR = "6";
  resetConfigCache();
  resetStoreCache();
});

describe("parseActiveHours", () => {
  it("parses a window", () => {
    expect(parseActiveHours("8-22")).toEqual({ start: 8, end: 22 });
  });

  it("rejects nonsense", () => {
    expect(() => parseActiveHours("rano")).toThrow();
    expect(() => parseActiveHours("8-30")).toThrow();
  });
});

describe("inActiveWindow", () => {
  it("handles a daytime window", () => {
    expect(inActiveWindow(8, { start: 8, end: 22 })).toBe(true);
    expect(inActiveWindow(22, { start: 8, end: 22 })).toBe(false);
    expect(inActiveWindow(3, { start: 8, end: 22 })).toBe(false);
  });

  it("handles a window that wraps midnight", () => {
    expect(inActiveWindow(23, { start: 22, end: 6 })).toBe(true);
    expect(inActiveWindow(2, { start: 22, end: 6 })).toBe(true);
    expect(inActiveWindow(12, { start: 22, end: 6 })).toBe(false);
  });

  it("treats start === end as always on", () => {
    expect(inActiveWindow(13, { start: 0, end: 0 })).toBe(true);
  });
});

describe("runtime limits", () => {
  it("defaults to the environment", async () => {
    const limits = await getLimits("main");
    expect(limits.likesPerDay).toBe(30);
    expect(limits.offersPerDay).toBe(10);
    expect(limits.actionsPerHour).toBe(6);
  });

  it("overrides only the fields that were set", async () => {
    const limits = await setLimits("main", { offersPerDay: 3 });
    expect(limits.offersPerDay).toBe(3);
    expect(limits.likesPerDay).toBe(30);
  });

  it("keeps overrides per account", async () => {
    await setLimits("main", { offersPerDay: 3 });
    expect((await getLimits("other")).offersPerDay).toBe(10);
  });

  it("goes back to defaults on reset", async () => {
    await setLimits("main", { offersPerDay: 3 });
    await resetLimits("main");
    expect((await getLimits("main")).offersPerDay).toBe(10);
  });

  it("rejects negative, fractional and out-of-range values", () => {
    expect(() => validateOverrides({ likesPerDay: -1 })).toThrow();
    expect(() => validateOverrides({ likesPerDay: 1.5 })).toThrow();
    expect(() => validateOverrides({ discountPct: 95 })).toThrow();
    expect(() => validateOverrides({ activeHours: { start: 8, end: 25 } })).toThrow();
  });
});

describe("checkBudget", () => {
  it("allows an action under the limit", async () => {
    expect(await checkBudget("main", "offer", { automatic: false })).toEqual({ ok: true });
  });

  it("blocks the action after the daily limit", async () => {
    await setLimits("main", { offersPerDay: 2 });
    await consumeBudget("main", "offer", { automatic: false });
    await consumeBudget("main", "offer", { automatic: false });
    const verdict = await checkBudget("main", "offer", { automatic: false });
    expect(verdict).toMatchObject({ ok: false, reason: "daily" });
  });

  it("treats a limit of 0 as disabled", async () => {
    await setLimits("main", { likesPerDay: 0 });
    expect(await checkBudget("main", "like", { automatic: false })).toMatchObject({
      ok: false,
      reason: "disabled",
    });
  });

  it("applies the hourly limit to automatic actions only", async () => {
    await setLimits("main", { actionsPerHour: 1 });
    await consumeBudget("main", "like", { automatic: true });
    expect(await checkBudget("main", "like", { automatic: true })).toMatchObject({
      ok: false,
      reason: "hourly",
    });
    expect(await checkBudget("main", "like", { automatic: false })).toEqual({ ok: true });
  });

  it("holds automatic actions outside the activity window", async () => {
    const hour = localHour();
    await setLimits("main", {
      activeHours: { start: (hour + 1) % 24, end: (hour + 2) % 24 },
    });
    expect(await checkBudget("main", "like", { automatic: true })).toMatchObject({
      ok: false,
      reason: "window",
    });
  });
});

describe("circuit breaker", () => {
  it("pauses automatic actions and can be resumed", async () => {
    await tripBreaker("main", "403 from Vinted");
    expect(await getAutopause("main")).toMatchObject({ reason: "403 from Vinted" });
    expect(await checkBudget("main", "like", { automatic: true })).toMatchObject({
      ok: false,
      reason: "paused",
    });
    await resumeAutomation("main");
    expect(await getAutopause("main")).toBeNull();
  });

  it("uses the account's autopause length", async () => {
    await setLimits("main", { autopauseHours: 2 });
    const pause = await tripBreaker("main", "x");
    const hours = (new Date(pause.until).getTime() - new Date(pause.since).getTime()) / 3_600_000;
    expect(hours).toBeCloseTo(2);
  });
});
