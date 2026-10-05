import { afterEach, describe, expect, it, vi } from "vitest";
import { describeProAccount, getProAccount } from "../src/pro/accounts.js";
import { buildQuery, getProClient } from "../src/pro/client.js";
import { ProError, ProInputError } from "../src/pro/errors.js";
import { assertProPath, PRO_BASE_URLS, proBaseUrl, safeId } from "../src/pro/hosts.js";
import { jsonRes } from "./helpers.js";
import { ACCESS_KEY, addAccount, setupPro, SIGNING_KEY } from "./pro-helpers.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function failure(promise: Promise<unknown>): Promise<ProError> {
  try {
    await promise;
  } catch (err) {
    return err as ProError;
  }
  throw new Error("expected the call to fail");
}

describe("buildQuery", () => {
  it("encodes, keeps the order given and skips empty values", () => {
    expect(buildQuery({ b: 2, a: "x y", skip: undefined, none: null, empty: "" })).toBe("b=2&a=x%20y");
  });

  it("escapes the characters URL parsing would rewrite, so the signed text is the text sent", () => {
    expect(buildQuery({ q: "it's (a) test*!" })).toBe("q=it%27s%20%28a%29%20test%2A%21");
  });
});

describe("a signed call", () => {
  it("passes the independent signature check and carries nothing it should not", async () => {
    const { fake, net } = setupPro();
    await addAccount();
    const account = await getProAccount();
    const { status, data } = await getProClient().json<{ catalogs: unknown[] }>(account, "GET", "/api/v1/ontologies");
    expect(status).toBe(200);
    expect(data.catalogs).toBeTruthy();

    expect(fake.requests).toHaveLength(1);
    const sent = fake.requests[0]!;
    expect(sent.signatureOk).toBe(true);
    expect(sent.headers["x-vpi-access-key"]).toBe(ACCESS_KEY);
    expect(sent.headers["accept"]).toBe("application/json");
    expect(Object.keys(sent.headers)).not.toContain("cookie");
    expect(Object.keys(sent.headers)).not.toContain("authorization");
    expect(JSON.stringify(sent.headers)).not.toContain(SIGNING_KEY);
    expect(String(net.calls[0]!.url)).toBe(`${PRO_BASE_URLS.sandbox}/api/v1/ontologies`);
  });

  it("signs exactly the body it sends, and the query string as written", async () => {
    const { fake } = setupPro();
    await addAccount();
    const account = await getProAccount();
    const payload = { items: [{ title: "Kurtka żółta", note: "aé" }] };
    await getProClient().json(account, "POST", "/api/v1/items/validate", { body: payload });
    await getProClient().json(account, "GET", "/api/v1/orders", { query: { "after-id": "123", note: "it's" } });

    const [post, get] = fake.requests;
    expect(post!.body).toBe(JSON.stringify(payload));
    expect(post!.headers["content-type"]).toBe("application/json");
    expect(post!.signatureOk).toBe(true);
    expect(get!.path).toBe("/api/v1/orders?after-id=123&note=it%27s");
    expect(get!.signatureOk).toBe(true);
    expect(get!.headers["content-type"]).toBeUndefined();
  });

  it("uses the production host for a production account", async () => {
    const { net } = setupPro();
    await addAccount("Prod", "production");
    await getProClient().json(await getProAccount(), "GET", "/api/v1/ontologies");
    expect(String(net.calls[0]!.url).startsWith(PRO_BASE_URLS.production)).toBe(true);
  });
});

describe("retries", () => {
  it("repeats a GET after a 503 and signs the second attempt afresh", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    vi.setSystemTime(new Date("2026-03-01T10:00:00Z"));
    let attempts = 0;
    const { fake } = setupPro({}, () => (++attempts === 1 ? jsonRes(503, { error: "UNAVAILABLE" }) : undefined));
    await addAccount();
    const account = await getProAccount();

    const call = getProClient().json(account, "GET", "/api/v1/ontologies");
    await vi.advanceTimersByTimeAsync(5000);
    await expect(call).resolves.toMatchObject({ status: 200 });

    expect(attempts).toBe(2);
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]!.signatureOk).toBe(true);
  });

  it("does not repeat a POST after a 503: creating twice is worse than failing once", async () => {
    let attempts = 0;
    setupPro({}, () => {
      attempts++;
      return jsonRes(503, { error: "UNAVAILABLE" });
    });
    await addAccount();
    const err = await failure(getProClient().json(await getProAccount(), "POST", "/api/v1/items", { body: { items: [] } }));
    expect(err.kind).toBe("server");
    expect(attempts).toBe(1);
  });

  it("waits out a 429 and repeats it, even for a POST (it was refused before it did anything)", async () => {
    let attempts = 0;
    const { fake } = setupPro({}, () => (++attempts === 1 ? jsonRes(429, { error: "TOO_MANY" }, { "retry-after": "0" }) : undefined));
    await addAccount();
    const { status } = await getProClient().json(await getProAccount(), "POST", "/api/v1/items/validate", { body: { items: [] } });
    expect(status).toBe(200);
    expect(attempts).toBe(2);
    expect(fake.requests).toHaveLength(1);
  });

  it("gives up on a 429 that does not clear and reports when to retry", async () => {
    setupPro({ VINTED_PRO_MAX_RETRIES: "1" }, () => jsonRes(429, { error: "TOO_MANY" }, { "retry-after": "0" }));
    await addAccount();
    const err = await failure(getProClient().json(await getProAccount(), "GET", "/api/v1/ontologies"));
    expect(err.kind).toBe("rate_limited");
    expect(err.retryAfterSeconds).toBe(0);
  });

  it("repeats a GET after a network error but not a POST, and says the POST may have gone through", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    let gets = 0;
    let posts = 0;
    setupPro({}, (_url, init) => {
      if (init?.method === "POST") {
        posts++;
        throw new TypeError("fetch failed");
      }
      gets++;
      throw new TypeError("fetch failed");
    });
    await addAccount();
    const account = await getProAccount();

    const get = failure(getProClient().json(account, "GET", "/api/v1/ontologies"));
    await vi.advanceTimersByTimeAsync(20_000);
    const getErr = await get;
    expect(getErr.kind).toBe("network");
    expect(gets).toBe(3);

    const postErr = await failure(getProClient().json(account, "POST", "/api/v1/items", { body: { items: [] } }));
    expect(posts).toBe(1);
    expect(postErr.message).toMatch(/may or may not have been processed/);
  });

  it("explains a timeout", async () => {
    setupPro({ VINTED_PRO_MAX_RETRIES: "0" }, () => {
      throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    });
    await addAccount();
    const err = await failure(getProClient().json(await getProAccount(), "GET", "/api/v1/ontologies"));
    expect(err.message).toMatch(/did not answer within 30 s/);
  });
});

describe("what an error says", () => {
  it("turns a wrong signature into advice, and flags the account", async () => {
    setupPro();
    await addAccount("Zły", "sandbox", `${ACCESS_KEY},not-the-key`);
    const account = await getProAccount();
    const err = await failure(getProClient().json(account, "GET", "/api/v1/ontologies"));
    expect(err).toBeInstanceOf(ProError);
    expect(err.kind).toBe("auth");
    expect(err.status).toBe(401);
    expect(err.code).toBe("INVALID_SIGNATURE");
    expect(err.message).toMatch(/same environment/);
    expect(err.message).toMatch(/clock/);
    expect(err.message).not.toContain("not-the-key");
    expect((await describeProAccount(account.id))?.status).toBe("rejected");
  });

  it("restores the account when a later call succeeds", async () => {
    let reject = true;
    setupPro({}, () => (reject ? jsonRes(401, { error: "INVALID_SIGNATURE" }) : undefined));
    await addAccount();
    const account = await getProAccount();
    await failure(getProClient().json(account, "GET", "/api/v1/ontologies"));
    expect((await describeProAccount(account.id))?.status).toBe("rejected");
    reject = false;
    await getProClient().json(await getProAccount(), "GET", "/api/v1/ontologies");
    const after = await describeProAccount(account.id);
    expect(after).toMatchObject({ status: "connected", statusReason: null });
    expect(after?.lastOkAt).toBeTruthy();
  });

  it("names the allowlist and the market on a 403, including that Poland is not listed", async () => {
    setupPro({}, () => jsonRes(403, { error: "NOT_ALLOWLISTED" }));
    await addAccount();
    const account = await getProAccount();
    const err = await failure(getProClient().json(account, "GET", "/api/v1/ontologies"));
    expect(err.kind).toBe("forbidden");
    expect(err.message).toMatch(/allowlist/);
    expect(err.message).toMatch(/Poland/);
    expect((await describeProAccount(account.id))?.status).toBe("rejected");
  });

  it("maps 404 and 422 and keeps Vinted's error body for the caller", async () => {
    setupPro({}, (url) => {
      if (url.pathname.endsWith("/validate")) return jsonRes(422, { error: "TOO_MANY_ITEMS", items: [{ field: "title" }] });
      return undefined;
    });
    await addAccount();
    const account = await getProAccount();
    const notFound = await failure(getProClient().json(account, "GET", "/api/v1/orders/999"));
    expect(notFound).toMatchObject({ kind: "not_found", status: 404, code: "ORDER_NOT_FOUND" });
    const invalid = await failure(getProClient().json(account, "POST", "/api/v1/items/validate", { body: { items: [] } }));
    expect(invalid).toMatchObject({ kind: "validation", status: 422, code: "TOO_MANY_ITEMS" });
    expect(invalid.details).toMatchObject({ items: [{ field: "title" }] });
  });

  it("does not follow a redirect with a signed request", async () => {
    const { net } = setupPro({}, () => new Response(null, { status: 302, headers: { location: "https://elsewhere.example/" } }));
    await addAccount();
    const err = await failure(getProClient().json(await getProAccount(), "GET", "/api/v1/ontologies"));
    expect(err.kind).toBe("unexpected");
    expect(err.message).toMatch(/not followed/);
    expect(net.calls).toHaveLength(1);
    expect((net.calls[0]!.init as RequestInit).redirect).toBe("manual");
  });

  it("scrubs a key that the server happens to echo back", async () => {
    setupPro({}, () => new Response(`<html>bad request for key ${SIGNING_KEY} and ${ACCESS_KEY}</html>`, { status: 418, headers: { "content-type": "text/html" } }));
    await addAccount();
    const err = await failure(getProClient().json(await getProAccount(), "GET", "/api/v1/ontologies"));
    expect(err.message).not.toContain(SIGNING_KEY);
    expect(err.message).not.toContain(ACCESS_KEY);
    expect(err.message).toContain("[hidden]");
  });

  it("refuses an answer that is not JSON", async () => {
    setupPro({}, () => new Response("<html>maintenance</html>", { status: 200, headers: { "content-type": "text/html" } }));
    await addAccount();
    const err = await failure(getProClient().json(await getProAccount(), "GET", "/api/v1/ontologies"));
    expect(err.kind).toBe("unexpected");
    expect(err.message).toMatch(/not with JSON/);
  });
});

describe("pdf", () => {
  it("returns the bytes of a real PDF and asks for one", async () => {
    const { fake } = setupPro();
    await addAccount();
    const order = fake.addOrder({ labelReady: true });
    const label = await getProClient().pdf(await getProAccount(), `/api/v1/orders/${order.id}/shipment-label`);
    expect(Buffer.from(label.bytes.subarray(0, 5)).toString()).toBe("%PDF-");
    expect(label.contentType).toBe("application/pdf");
    expect(fake.requests[0]!.headers["accept"]).toBe("application/pdf");
    expect(fake.requests[0]!.signatureOk).toBe(true);
  });

  it("reports a missing label as not found, and a non-PDF 200 as an error", async () => {
    const { fake } = setupPro({}, (url) => (url.pathname.endsWith("/555/shipment-label") ? new Response("hello", { status: 200 }) : undefined));
    await addAccount();
    const account = await getProAccount();
    const early = fake.addOrder({ labelReady: false });
    expect((await failure(getProClient().pdf(account, `/api/v1/orders/${early.id}/shipment-label`))).kind).toBe("not_found");
    expect((await failure(getProClient().pdf(account, "/api/v1/orders/555/shipment-label"))).message).toMatch(/not a PDF/);
  });
});

describe("where a signed request may go", () => {
  it("defaults to Vinted's two documented hosts", () => {
    setupPro();
    expect(proBaseUrl("sandbox")).toBe("https://pro-public-sandbox.svc.vinted.com");
    expect(proBaseUrl("production")).toBe("https://pro.svc.vinted.com");
  });

  it("accepts an override in tests but, in production, only an https address under vinted.com", () => {
    setupPro({ VINTED_PRO_BASE_URL_SANDBOX: "http://127.0.0.1:4000/ignored/path" });
    expect(proBaseUrl("sandbox")).toBe("http://127.0.0.1:4000");

    setupPro({ NODE_ENV: "production", VINTED_PRO_BASE_URL_SANDBOX: "http://127.0.0.1:4000" });
    expect(() => proBaseUrl("sandbox")).toThrow(/under vinted\.com/);
    setupPro({ NODE_ENV: "production", VINTED_PRO_BASE_URL_SANDBOX: "https://evil.example" });
    expect(() => proBaseUrl("sandbox")).toThrow(/under vinted\.com/);
    setupPro({ NODE_ENV: "production", VINTED_PRO_BASE_URL_SANDBOX: "https://pro-eu.svc.vinted.com" });
    expect(proBaseUrl("sandbox")).toBe("https://pro-eu.svc.vinted.com");
    setupPro({ VINTED_PRO_BASE_URL_SANDBOX: "not a url" });
    expect(() => proBaseUrl("sandbox")).toThrow(/valid URL/);
  });

  it("allows only API paths, and ids that cannot climb out of them", () => {
    expect(assertProPath("/api/v1/items")).toBe("/api/v1/items");
    expect(assertProPath("/api/v2/item-price-suggestions")).toBe("/api/v2/item-price-suggestions");
    for (const bad of ["/oauth/token", "api/v1/items", "/api/v1/../admin", "/api/v1//items", "/api/v1/items?x=1", "/api/v1/items#x", "https://evil.example/api/v1/x", "/api/x/items"]) {
      expect(() => assertProPath(bad)).toThrow(ProInputError);
    }
    expect(safeId("3f0c6c1e-8a2b-4c1e-9a77-1d2b3c4d5e6f")).toBeTruthy();
    expect(safeId("987654321")).toBe("987654321");
    for (const bad of ["", "a/b", "..", "a?b", "a b", "x".repeat(65)]) {
      expect(() => safeId(bad)).toThrow(ProInputError);
    }
  });

  it("never signs or sends a request to a path outside the API", async () => {
    const { net } = setupPro();
    await addAccount();
    const err = await failure(getProClient().json(await getProAccount(), "GET", "/api/v1/../../etc"));
    expect(err).toBeInstanceOf(ProInputError);
    expect(net.calls).toHaveLength(0);
  });
});
