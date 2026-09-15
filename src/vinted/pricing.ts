import type { NormalisedItem } from "./types.js";

/**
 * Turns a set of comparable listings into a price recommendation.
 *
 * Vinted's public catalog shows what sellers are *asking*, not what buyers
 * paid, so everything here is explicitly an asking-price distribution. The
 * confidence field exists to stop a three-item sample from reading like a
 * firm valuation.
 */

export interface PriceDistribution {
  sampleSize: number;
  currency: string | null;
  min: number;
  p25: number;
  median: number;
  p75: number;
  max: number;
  mean: number;
}

export interface PriceEstimate {
  distribution: PriceDistribution;
  /** Priced to move, roughly the 25th percentile. */
  quickSale: number;
  /** The balanced ask, the median of comparable listings. */
  recommended: number;
  /** Patient pricing, roughly the 75th percentile. */
  ambitious: number;
  confidence: "low" | "medium" | "high";
  /** Plain-language reasons behind the confidence rating. */
  notes: string[];
}

export function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0]!;
  const rank = (sorted.length - 1) * fraction;
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  const lowValue = sorted[low]!;
  if (low === high) return lowValue;
  return lowValue + (sorted[high]! - lowValue) * (rank - low);
}

const round2 = (value: number) => Math.round(value * 100) / 100;

/**
 * Discards prices far outside the bulk of the sample. Vinted listings include
 * the occasional 1 PLN placeholder and the occasional wildly overpriced item;
 * both would drag a mean around.
 */
export function rejectOutliers(prices: number[]): number[] {
  if (prices.length < 5) return prices;
  const sorted = [...prices].sort((a, b) => a - b);
  const q1 = percentile(sorted, 0.25);
  const q3 = percentile(sorted, 0.75);
  const iqr = q3 - q1;
  if (iqr === 0) return sorted;
  const low = q1 - 1.5 * iqr;
  const high = q3 + 1.5 * iqr;
  const kept = sorted.filter((p) => p >= low && p <= high);
  return kept.length >= 3 ? kept : sorted;
}

export function estimateFromComps(comps: NormalisedItem[]): PriceEstimate | null {
  const priced = comps.filter(
    (c): c is NormalisedItem & { price: number } =>
      typeof c.price === "number" && c.price > 0,
  );
  if (priced.length === 0) return null;

  const currency = priced.find((c) => c.currency)?.currency ?? null;
  const cleaned = rejectOutliers(priced.map((c) => c.price)).sort(
    (a, b) => a - b,
  );

  const distribution: PriceDistribution = {
    sampleSize: cleaned.length,
    currency,
    min: round2(cleaned[0]!),
    p25: round2(percentile(cleaned, 0.25)),
    median: round2(percentile(cleaned, 0.5)),
    p75: round2(percentile(cleaned, 0.75)),
    max: round2(cleaned[cleaned.length - 1]!),
    mean: round2(cleaned.reduce((a, b) => a + b, 0) / cleaned.length),
  };

  const spread =
    distribution.median > 0
      ? (distribution.p75 - distribution.p25) / distribution.median
      : Infinity;

  const notes: string[] = [];
  let confidence: PriceEstimate["confidence"];
  if (cleaned.length >= 15 && spread <= 0.6) {
    confidence = "high";
    notes.push(`${cleaned.length} comparable listings with a tight spread.`);
  } else if (cleaned.length >= 6 && spread <= 1.2) {
    confidence = "medium";
    notes.push(`${cleaned.length} comparable listings, moderate spread.`);
  } else {
    confidence = "low";
    notes.push(
      cleaned.length < 6
        ? `Only ${cleaned.length} comparable listings found - treat this as a rough guide.`
        : `Prices vary widely (${distribution.p25}-${distribution.p75}), so the midpoint is soft.`,
    );
  }
  notes.push(
    "Based on active asking prices, not completed sales - Vinted does not expose sold prices publicly.",
  );

  return {
    distribution,
    quickSale: distribution.p25,
    recommended: distribution.median,
    ambitious: distribution.p75,
    confidence,
    notes,
  };
}
