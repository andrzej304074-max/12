import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { proEndpoints } from "../src/pro/endpoints.js";
import { ITEMS_CURSOR_PARAM, ORDERS_CURSOR_PARAM } from "../src/pro/schema.js";

/**
 * Checks the paths this integration calls against Vinted's own OpenAPI file.
 *
 * The documentation the integration was written from was pieced together from
 * fragments, and much of it is marked "probable" or "unconfirmed". The official
 * specification settles all of that: download it from
 *   https://pro-docs.svc.vinted.com/downloads/api.yml
 * and save it as docs/vinted-pro/api.yml. Until the file exists these tests are
 * skipped; once it does, every difference between what the code calls and what
 * Vinted publishes fails here, with the nearest paths in the spec.
 */

const SPEC = "docs/vinted-pro/api.yml";
const present = existsSync(SPEC);
const ID = "__ID__";

type Spec = { paths?: Record<string, Record<string, { parameters?: { name?: string; in?: string }[] }>> };

const normalise = (path: string) => path.replace(/\{[^}]*\}/g, "{}").replace(new RegExp(ID, "g"), "{}");

const USED: { method: string; path: string; what: string }[] = [
  { method: "get", path: proEndpoints.ontologies(), what: "ontologies" },
  { method: "get", path: proEndpoints.priceSuggestions(), what: "price suggestions" },
  { method: "get", path: proEndpoints.items(), what: "list items" },
  { method: "post", path: proEndpoints.items(), what: "create items" },
  { method: "put", path: proEndpoints.items(), what: "update items" },
  { method: "delete", path: proEndpoints.items(), what: "delete items" },
  { method: "post", path: proEndpoints.itemsValidate(), what: "validate items" },
  { method: "get", path: proEndpoints.itemStatus(ID), what: "item status" },
  { method: "get", path: proEndpoints.itemsImported(), what: "imported items" },
  { method: "put", path: proEndpoints.itemReferences(), what: "item references" },
  { method: "get", path: proEndpoints.orders(), what: "list orders" },
  { method: "get", path: proEndpoints.order(ID), what: "order" },
  { method: "get", path: proEndpoints.orderShipment(ID), what: "shipment" },
  { method: "get", path: proEndpoints.orderLabel(ID), what: "shipping label" },
  { method: "post", path: proEndpoints.orderCancel(ID), what: "cancel order" },
  { method: "post", path: proEndpoints.ordersRelist(), what: "relist orders" },
  { method: "get", path: proEndpoints.webhooks(), what: "list webhooks" },
  { method: "post", path: proEndpoints.webhooks(), what: "register webhook" },
  { method: "delete", path: proEndpoints.webhook(ID), what: "delete webhook" },
];

describe.skipIf(!present)("the code against Vinted's OpenAPI file", () => {
  const spec = (present ? parse(readFileSync(SPEC, "utf8")) : {}) as Spec;
  const byNormalised = new Map<string, Record<string, { parameters?: { name?: string; in?: string }[] }>>();
  for (const [path, item] of Object.entries(spec.paths ?? {})) byNormalised.set(normalise(path), item);

  it("is an OpenAPI document with paths", () => {
    expect(byNormalised.size).toBeGreaterThan(5);
  });

  it.each(USED)("has $method $what ($path)", ({ method, path }) => {
    const item = byNormalised.get(normalise(path));
    const near = [...byNormalised.keys()].filter((p) => p.split("/")[3] === normalise(path).split("/")[3]);
    expect(item, `no path ${normalise(path)} in the spec; nearest: ${near.join(", ") || "none"}`).toBeDefined();
    expect(Object.keys(item!), `${normalise(path)} has no ${method}; it has ${Object.keys(item!).join(", ")}`).toContain(method);
  });

  it("uses the cursor parameter names the spec declares", () => {
    const names = (path: string, method: string) =>
      (byNormalised.get(normalise(path))?.[method]?.parameters ?? []).filter((p) => p.in === "query").map((p) => p.name);
    expect(names(proEndpoints.orders(), "get"), `the spec's order parameters; the code uses "${ORDERS_CURSOR_PARAM}"`).toContain(ORDERS_CURSOR_PARAM);
    expect(names(proEndpoints.items(), "get"), `the spec's item parameters; the code uses "${ITEMS_CURSOR_PARAM}"`).toContain(ITEMS_CURSOR_PARAM);
  });
});

describe("without the spec file", () => {
  it("says what to do", () => {
    if (present) return;
    expect(existsSync(SPEC)).toBe(false);
    // Skipped contract tests are not a pass; this reminder is the visible trace.
    expect(SPEC).toBe("docs/vinted-pro/api.yml");
  });
});
