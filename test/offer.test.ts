import { describe, expect, it } from "vitest";
import { offerPriceFor } from "../src/monitor/engine.js";

describe("offerPriceFor", () => {
  it("applies the default 20 percent discount", () => {
    expect(offerPriceFor(100, 20)).toBe(80);
  });

  it("rounds to whole currency units", () => {
    expect(offerPriceFor(49.99, 20)).toBe(40);
  });

  it("never proposes zero or less", () => {
    expect(offerPriceFor(1, 20)).toBe(1);
    expect(offerPriceFor(2, 90)).toBe(1);
  });

  it("clamps absurd discounts to 90 percent", () => {
    expect(offerPriceFor(100, 150)).toBe(10);
  });

  it("treats a negative discount as no discount", () => {
    expect(offerPriceFor(100, -50)).toBe(100);
  });

  it("returns null for an unusable asking price", () => {
    expect(offerPriceFor(null, 20)).toBeNull();
    expect(offerPriceFor(0, 20)).toBeNull();
    expect(offerPriceFor(Number.NaN, 20)).toBeNull();
  });
});
