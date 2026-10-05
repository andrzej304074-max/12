import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveAccount } from "../src/vinted/accounts.js";
import { RefusalError, VintedClient, VintedError } from "../src/vinted/client.js";
import { freshEnv, htmlRes, jsonRes, mockFetch } from "./helpers.js";

const WALL = { url: "https://geo.captcha-delivery.com/captcha/?initialCid=AAAA" };
/** The error a call fails with; fails the test if the call succeeds. */
const failure = (call: Promise<unknown>): Promise<any> =>
  call.then(
    () => {
      throw new Error("expected the call to fail");
    },
    (error: unknown) => error,
  );
const home = () => new Response("<html></html>", { headers: { "content-type": "text/html" } });

beforeEach(() => freshEnv());
afterEach(() => vi.unstubAllGlobals());

/** Answers the anonymous-session request, then hands the API request to `api`. */
function vinted(api: () => Response) {
  return mockFetch((url) => (url.pathname === "/" ? home() : api()));
}
const apiCalls = (calls: { url: URL }[]) => calls.filter((c) => c.url.pathname.startsWith("/api/"));

describe("reading", () => {
  it("names a bot-protection challenge as such and does not retry it", async () => {
    const { calls } = vinted(() => jsonRes(403, WALL, { "x-datadome": "protected" }));
    const err = await failure(new VintedClient().get("/api/v2/catalogs"));
    expect(err).toBeInstanceOf(VintedError);
    expect(err.message).toMatch(/bot protection blocked this request/);
    expect(err.message).toMatch(/header:x-datadome/);
    expect(apiCalls(calls)).toHaveLength(1);
  });

  it("does not retry a 503 Cloudflare challenge either", async () => {
    const { calls } = vinted(() => htmlRes(503, "<title>Just a moment...</title>"));
    await expect(new VintedClient().get("/api/v2/catalogs")).rejects.toThrow(/bot protection blocked/);
    expect(apiCalls(calls)).toHaveLength(1);
  });

  it("still backs off and retries an ordinary 503", async () => {
    const { calls } = vinted(() => htmlRes(503, "<html>Service unavailable</html>"));
    await expect(new VintedClient().get("/api/v2/catalogs")).rejects.toThrow(/upstream returned 503/);
    expect(apiCalls(calls).length).toBeGreaterThan(1);
  }, 20_000);

  it("describes an anonymous 403 without claiming a block it cannot prove", async () => {
    vinted(() => htmlRes(403, "<html>Forbidden</html>"));
    const err = await failure(new VintedClient().get("/api/v2/catalogs"));
    expect(err.message).toMatch(/refused an anonymous read \(HTTP 403/);
    expect(err.message).toMatch(/no recognisable marker/);
    expect(err.message).not.toMatch(/bot protection blocked/);
  });

  it("does not call a 404 page that mentions DataDome a block", async () => {
    vinted(() => htmlRes(404, '<html><script src="https://js.datadome.co/tags.js"></script>Not found captcha</html>'));
    const err = await failure(new VintedClient().get("/api/v2/catalogs"));
    expect(err.message).toMatch(/unexpected answer \(HTTP 404/);
    expect(err.message).not.toMatch(/bot protection/);
  });

  it("explains a web page where JSON was expected, with a clean snippet", async () => {
    vinted(() => htmlRes(200, "<html><body><h1>Please update your app</h1></body></html>"));
    const err = await failure(new VintedClient().get("/api/v2/catalogs"));
    expect(err.message).toMatch(/web page instead of JSON/);
    expect(err.message).toContain("Please update your app");
    expect(err.message).not.toContain("<h1>");
  });

  it("still returns JSON normally", async () => {
    vinted(() => jsonRes(200, { catalogs: [1, 2] }));
    expect(await new VintedClient().get("/api/v2/catalogs")).toEqual({ catalogs: [1, 2] });
  });
});

describe("writing", () => {
  const account = async () => {
    await saveAccount({ label: "A", domain: "www.vinted.pl", userId: 1, login: "a", avatarUrl: null, secrets: { accessToken: "tok" } });
    return { id: "a", label: "A", accessToken: "tok", domain: "www.vinted.pl", source: "env" as const };
  };

  it("raises a refusal naming the challenge", async () => {
    const acc = await account();
    mockFetch(() => jsonRes(403, WALL, { "x-datadome": "protected" }));
    const err = await failure(new VintedClient().send("POST", "/api/v2/offers", { account: acc, body: {} }));
    expect(err).toBeInstanceOf(RefusalError);
    expect(err.message).toMatch(/bot protection blocked this request/);
  });

  it("keeps the session hint for a 403 without markers, and adds the evidence", async () => {
    const acc = await account();
    mockFetch(() => htmlRes(403, "<html>Forbidden</html>"));
    const err = await failure(new VintedClient().send("POST", "/api/v2/offers", { account: acc, body: {} }));
    expect(err).toBeInstanceOf(RefusalError);
    expect(err.message).toMatch(/session may have expired/);
    expect(err.message).toMatch(/HTTP 403/);
  });

  it("explains a web page served instead of JSON after a write", async () => {
    const acc = await account();
    mockFetch(() => htmlRes(200, "<html><body>Maintenance</body></html>"));
    const err = await failure(new VintedClient().send("POST", "/api/v2/offers", { account: acc, body: {} }));
    expect(err).toBeInstanceOf(RefusalError);
    expect(err.message).toMatch(/web page instead of JSON/);
    expect(err.message).toContain("Maintenance");
  });

  it("gives a clean snippet for an ordinary failure", async () => {
    const acc = await account();
    mockFetch(() => htmlRes(422, "<html><body>Price is too low</body></html>"));
    const err = await failure(new VintedClient().send("POST", "/api/v2/offers", { account: acc, body: {} }));
    expect(err).toBeInstanceOf(VintedError);
    expect(err.message).toMatch(/action failed \(HTTP 422/);
    expect(err.message).toContain("Price is too low");
  });
});
