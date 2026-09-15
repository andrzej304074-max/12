import { describe, expect, it } from "vitest";
import { readCookie } from "../src/vinted/client.js";
import { normaliseItem, parsePrice, type VintedItem } from "../src/vinted/types.js";

describe("parsePrice", () => {
  it("reads the nested money object", () => {
    expect(parsePrice({ amount: "49.50", currency_code: "PLN" })).toEqual({
      amount: 49.5,
      currency: "PLN",
    });
  });

  it("reads a bare string amount", () => {
    expect(parsePrice("30")).toEqual({ amount: 30, currency: null });
  });

  it("returns nulls for a missing price", () => {
    expect(parsePrice(undefined)).toEqual({ amount: null, currency: null });
  });

  it("returns null rather than NaN for junk", () => {
    expect(parsePrice("abc").amount).toBeNull();
  });
});

describe("normaliseItem", () => {
  const raw: VintedItem = {
    id: 123,
    title: "Kurtka",
    price: { amount: "80", currency_code: "PLN" },
    brand_title: "Zara",
    size_title: "M",
    status: "very good",
    favourite_count: 3,
    user: { id: 55, login: "ala" },
    photos: [{ full_size_url: "https://img/1.jpg" }],
  };

  it("flattens the fields the tools surface", () => {
    const item = normaliseItem(raw, "www.vinted.pl");
    expect(item).toMatchObject({
      id: "123",
      title: "Kurtka",
      price: 80,
      currency: "PLN",
      brand: "Zara",
      size: "M",
      sellerId: "55",
      sellerLogin: "ala",
      photoUrl: "https://img/1.jpg",
    });
  });

  it("builds a URL when the payload omits one", () => {
    expect(normaliseItem(raw, "www.vinted.pl").url).toBe(
      "https://www.vinted.pl/items/123",
    );
  });

  it("keeps the payload's own URL when present", () => {
    const item = normaliseItem({ ...raw, url: "https://x/y" }, "www.vinted.pl");
    expect(item.url).toBe("https://x/y");
  });

  it("survives an item with no photos", () => {
    const item = normaliseItem({ id: 1, title: "t" }, "www.vinted.pl");
    expect(item.photoUrl).toBeNull();
    expect(item.price).toBeNull();
  });
});

describe("readCookie", () => {
  it("extracts a named cookie from a Set-Cookie header", () => {
    expect(readCookie("access_token_web=abc123; Path=/; HttpOnly", "access_token_web")).toBe(
      "abc123",
    );
  });

  it("returns null when the cookie is absent", () => {
    expect(readCookie("other=1; Path=/", "access_token_web")).toBeNull();
  });
});
