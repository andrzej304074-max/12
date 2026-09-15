import { describe, expect, it } from "vitest";
import {
  estimateFromComps,
  percentile,
  rejectOutliers,
} from "../src/vinted/pricing.js";
import type { NormalisedItem } from "../src/vinted/types.js";

function comp(price: number | null, currency = "PLN"): NormalisedItem {
  return {
    id: `${Math.random()}`,
    title: "item",
    price,
    currency,
    brand: null,
    size: null,
    condition: null,
    url: null,
    favourites: null,
    sellerId: null,
    sellerLogin: null,
    photoUrl: null,
    createdAt: null,
  };
}

describe("percentile", () => {
  it("returns the only value for a single-element sample", () => {
    expect(percentile([42], 0.5)).toBe(42);
  });

  it("interpolates between neighbours", () => {
    expect(percentile([10, 20, 30, 40], 0.5)).toBe(25);
  });

  it("returns 0 for an empty sample rather than NaN", () => {
    expect(percentile([], 0.5)).toBe(0);
  });
});

describe("rejectOutliers", () => {
  it("leaves small samples untouched", () => {
    const prices = [1, 500, 3, 4];
    expect(rejectOutliers(prices)).toEqual(prices);
  });

  it("drops a placeholder price and a wild outlier", () => {
    const prices = [1, 48, 50, 52, 55, 49, 51, 5000];
    const kept = rejectOutliers(prices);
    expect(kept).not.toContain(1);
    expect(kept).not.toContain(5000);
    expect(kept).toContain(50);
  });

  it("keeps the original sample when filtering would leave too little", () => {
    const prices = [10, 10, 10, 1000, 2000];
    expect(rejectOutliers(prices).length).toBeGreaterThanOrEqual(3);
  });
});

describe("estimateFromComps", () => {
  it("returns null when nothing has a usable price", () => {
    expect(estimateFromComps([comp(null), comp(0)])).toBeNull();
  });

  it("orders the three price points", () => {
    const comps = [30, 40, 45, 50, 55, 60, 70].map((p) => comp(p));
    const estimate = estimateFromComps(comps)!;
    expect(estimate.quickSale).toBeLessThanOrEqual(estimate.recommended);
    expect(estimate.recommended).toBeLessThanOrEqual(estimate.ambitious);
  });

  it("rates a large, tight sample as high confidence", () => {
    const comps = Array.from({ length: 20 }, (_, i) => comp(50 + (i % 4)));
    expect(estimateFromComps(comps)!.confidence).toBe("high");
  });

  it("rates a tiny sample as low confidence", () => {
    const estimate = estimateFromComps([comp(50), comp(55)])!;
    expect(estimate.confidence).toBe("low");
    expect(estimate.notes.join(" ")).toContain("Only 2");
  });

  it("carries the currency through from the comps", () => {
    const estimate = estimateFromComps([comp(50, "EUR"), comp(60, "EUR")])!;
    expect(estimate.distribution.currency).toBe("EUR");
  });

  it("always says the numbers are asking prices, not sales", () => {
    const estimate = estimateFromComps([comp(50), comp(60)])!;
    expect(estimate.notes.join(" ")).toContain("not completed sales");
  });
});
