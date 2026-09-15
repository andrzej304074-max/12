import { describe, expect, it } from "vitest";
import { checkDraft, LIMITS, type DraftInput } from "../src/mcp/tools/listing.js";

function draft(overrides: Partial<DraftInput> = {}): DraftInput {
  return {
    title: "Nike Air Max 90, rozmiar 42, biale",
    description:
      "Buty w bardzo dobrym stanie, noszone kilka razy. Wkladka 26.5 cm. Bez wad.",
    price: 180,
    currency: "PLN",
    brand: "Nike",
    size: "42",
    condition: "very good",
    catalogId: 1234,
    brandId: 53,
    photoCount: 5,
    ...overrides,
  };
}

describe("checkDraft", () => {
  it("passes a complete draft", () => {
    expect(checkDraft(draft())).toEqual([]);
  });

  it("blocks an over-long title", () => {
    const issues = checkDraft(draft({ title: "x".repeat(LIMITS.titleMax + 1) }));
    expect(issues).toContainEqual(
      expect.objectContaining({ field: "title", severity: "blocker" }),
    );
  });

  it("blocks a missing price", () => {
    expect(checkDraft(draft({ price: undefined }))).toContainEqual(
      expect.objectContaining({ field: "price", severity: "blocker" }),
    );
  });

  it("blocks a zero price", () => {
    expect(checkDraft(draft({ price: 0 }))).toContainEqual(
      expect.objectContaining({ field: "price", severity: "blocker" }),
    );
  });

  it("blocks a missing category", () => {
    expect(checkDraft(draft({ catalogId: undefined }))).toContainEqual(
      expect.objectContaining({ field: "catalog_id", severity: "blocker" }),
    );
  });

  it("blocks a listing with no photos", () => {
    expect(checkDraft(draft({ photoCount: 0 }))).toContainEqual(
      expect.objectContaining({ field: "photos", severity: "blocker" }),
    );
  });

  it("warns, but does not block, on too few photos", () => {
    const issues = checkDraft(draft({ photoCount: 2 }));
    expect(issues).toContainEqual(
      expect.objectContaining({ field: "photos", severity: "warning" }),
    );
    expect(issues.filter((i) => i.severity === "blocker")).toEqual([]);
  });

  it("warns on a missing size", () => {
    expect(checkDraft(draft({ size: undefined }))).toContainEqual(
      expect.objectContaining({ field: "size", severity: "warning" }),
    );
  });

  it("warns on a thin description", () => {
    expect(checkDraft(draft({ description: "ladne" }))).toContainEqual(
      expect.objectContaining({ field: "description", severity: "warning" }),
    );
  });
});
