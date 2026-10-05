import { describe, expect, it } from "vitest";
import { classify, cleanSnippet, collectEvidence, describeEvidence, outcomeFor } from "../src/vinted/evidence.js";

const headers = (init: Record<string, string> = {}) => new Headers(init);
const evidence = (status: number, body: string, h: Record<string, string> = {}, secrets: string[] = []) =>
  collectEvidence(status, headers(h), body, secrets);

describe("classify", () => {
  it("calls a DataDome JSON challenge a wall", () => {
    const e = evidence(403, '{"url":"https://geo.captcha-delivery.com/captcha/?initialCid=AAA"}', { "content-type": "application/json" });
    expect(e.markers).toContain("body:captcha-delivery.com");
    expect(classify(e, true)).toBe("wall");
  });

  it("calls a challenge header on a blocking status a wall", () => {
    expect(classify(evidence(403, "", { "x-datadome": "protected" }), false)).toBe("wall");
    expect(classify(evidence(403, "", { "x-dd-b": "1" }), false)).toBe("wall");
    expect(classify(evidence(503, "", { "cf-mitigated": "challenge" }), false)).toBe("wall");
  });

  it("recognises the Cloudflare interstitial and AWS WAF's 405 challenge", () => {
    expect(classify(evidence(503, "<title>Just a moment...</title>"), false)).toBe("wall");
    expect(classify(evidence(403, "<title>Attention Required! | Cloudflare</title>"), false)).toBe("wall");
    expect(classify(evidence(405, "", { "x-amzn-waf-action": "captcha" }), false)).toBe("wall");
  });

  // The false alarm this module exists to prevent.
  it("does NOT call an ordinary page a wall for mentioning captcha or DataDome", () => {
    const page = '<html><script src="https://js.datadome.co/tags.js"></script><body>captcha cloudflare datadome</body></html>';
    for (const status of [200, 404, 405, 301]) {
      expect(evidence(status, page).markers, `status ${status}`).toEqual([]);
      expect(classify(evidence(status, page), false), `status ${status}`).toBe("not_api");
    }
  });

  it("does not call a 200 with a challenge marker a wall (the status must block)", () => {
    expect(classify(evidence(200, "geo.captcha-delivery.com"), false)).toBe("not_api");
  });

  it("calls a plain 403 or 503 page without markers rejected", () => {
    expect(classify(evidence(403, "<html>Forbidden</html>"), false)).toBe("rejected");
    expect(classify(evidence(503, "<html>Unavailable</html>"), false)).toBe("rejected");
  });

  it("calls 429 a rate limit even when markers are present", () => {
    expect(classify(evidence(429, "", { "x-datadome": "protected" }), false)).toBe("rate_limited");
  });

  it("leaves JSON for the caller to read, whatever the status", () => {
    expect(classify(evidence(400, '{"error":"invalid_grant"}'), true)).toBe("api");
    expect(classify(evidence(403, '{"error":"two_factor_required"}'), true)).toBe("api");
    expect(classify(evidence(500, "{}"), true)).toBe("api");
  });

  it("calls a redirect or a 404 page not_api", () => {
    expect(classify(evidence(302, "", { location: "https://x/login" }), false)).toBe("not_api");
    expect(classify(evidence(404, "<html>Not found</html>"), false)).toBe("not_api");
  });
});

describe("collectEvidence", () => {
  it("records the server, content type and a redirect target without its query", () => {
    const e = evidence(302, "", { server: "cloudflare", "content-type": "text/html; charset=utf-8", location: "https://a.example/login?token=abc" });
    expect(e).toMatchObject({ status: 302, server: "cloudflare", contentType: "text/html; charset=utf-8", location: "https://a.example/login" });
  });

  it("reads DataDome from the server header", () => {
    expect(evidence(403, "", { server: "DataDome" }).markers).toContain("header:server=datadome");
  });

  it("keeps hints separate: a datadome cookie or cf-ray alone is not a block", () => {
    const e = evidence(403, "Forbidden", { "set-cookie": "datadome=abc123; Path=/, other=1", "cf-ray": "123-WAW" });
    expect(e.hints).toEqual(expect.arrayContaining(["sets a datadome cookie", "cloudflare in front (cf-ray)"]));
    expect(e.markers).toEqual([]);
    expect(classify(e, false)).toBe("rejected");
  });

  it("never records cookie values", () => {
    const e = evidence(200, "", { "set-cookie": "datadome=SUPERSECRETVALUE; Path=/" });
    expect(JSON.stringify(e)).not.toContain("SUPERSECRETVALUE");
  });

  it("lists each marker once", () => {
    const e = evidence(403, "captcha-delivery.com captcha-delivery.com");
    expect(e.markers.filter((m) => m === "body:captcha-delivery.com")).toHaveLength(1);
  });
});

describe("cleanSnippet", () => {
  it("strips markup, scripts and styles", () => {
    expect(cleanSnippet("<html><style>a{}</style><script>alert(1)</script><h1>Not   found</h1></html>")).toBe("Not found");
  });

  it("masks e-mail addresses and long token-like strings", () => {
    const out = cleanSnippet("user ala@example.com token eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9abcdef end");
    expect(out).toBe("user [email] token [...] end");
  });

  it("scrubs secrets that were sent, even when echoed", () => {
    expect(cleanSnippet("wrong password hunter2-secret for you", ["hunter2-secret"])).toBe("wrong password [hidden] for you");
  });

  it("ignores empty or very short secrets instead of mangling the text", () => {
    expect(cleanSnippet("abc xy", ["", "xy"])).toBe("abc xy");
  });

  it("truncates", () => {
    expect(cleanSnippet("word ".repeat(200)).length).toBeLessThanOrEqual(200);
  });
});

describe("describeEvidence and outcomeFor", () => {
  it("summarises in one line", () => {
    const e = evidence(403, "geo.captcha-delivery.com", { server: "DataDome", "content-type": "application/json" });
    expect(describeEvidence(e)).toBe(
      "HTTP 403, application/json, server DataDome; bot-protection markers: header:server=datadome, body:captcha-delivery.com",
    );
  });

  it("builds a body-free log outcome", () => {
    expect(outcomeFor("blocked", evidence(403, "", { "x-datadome": "1" }))).toBe("blocked http=403 header:x-datadome");
    expect(outcomeFor("unexpected", evidence(404, "<html>x</html>"))).toBe("unexpected http=404");
  });
});
