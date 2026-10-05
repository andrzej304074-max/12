import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { handleApp } from "../src/app/router.js";
import type { VercelLikeRequest, VercelLikeResponse } from "../src/http.js";
import { setupPro, ACCESS_KEY, PRO_TOKEN, SIGNING_KEY } from "./pro-helpers.js";

const put = vi.hoisted(() =>
  vi.fn(async (pathname: string, _body: unknown, opts: { contentType: string }) => ({
    url: `https://store123.public.blob.vercel-storage.com/${pathname}`,
    pathname,
    contentType: opts.contentType,
  })),
);
vi.mock("@vercel/blob", () => ({ put }));

/** The panel's Vinted Pro routes: the token goes in through a dedicated route and never comes back out. */

let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    void handleApp(req as VercelLikeRequest, res as VercelLikeResponse);
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
});

let fake: ReturnType<typeof setupPro>["fake"];
beforeEach(() => {
  ({ fake } = setupPro({ ADMIN_PASSWORD: "panel-pass" }));
});
afterEach(() => vi.unstubAllGlobals());

async function call(path: string, opts: { method?: string; body?: unknown; rawBody?: string; cookie?: string; origin?: string | null } = {}) {
  const method = opts.method ?? "GET";
  const origin = opts.origin === undefined ? (method === "GET" ? null : base) : opts.origin;
  const res = await fetch(`${base}/api/app${path}`, {
    method,
    headers: {
      ...(opts.body !== undefined || opts.rawBody !== undefined ? { "content-type": "application/json" } : {}),
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
      ...(origin ? { origin } : {}),
    },
    body: opts.rawBody ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json, text, setCookie: res.headers.get("set-cookie") };
}

async function signIn(): Promise<string> {
  const r = await call("/login", { method: "POST", body: { password: "panel-pass" } });
  return r.setCookie!.split(";")[0]!;
}

const good = { label: "Sklep główny", env: "sandbox", token: PRO_TOKEN };

describe("adding a Vinted Pro account", () => {
  it("needs a session and the panel's own origin", async () => {
    expect((await call("/pro-account", { method: "POST", body: good })).status).toBe(401);
    const cookie = await signIn();
    expect((await call("/pro-account", { method: "POST", body: good, cookie, origin: "https://evil.example" })).status).toBe(403);
    expect((await call("/pro-account", { method: "POST", body: good, cookie, origin: null })).status).toBe(403);
  });

  it("stores the token and answers with a summary that has no secret in it", async () => {
    const cookie = await signIn();
    const r = await call("/pro-account", { method: "POST", body: good, cookie });
    expect(r.status).toBe(200);
    expect(r.json.account).toMatchObject({ id: "pro-sklep-glowny", label: "Sklep główny", env: "sandbox", status: "connected" });
    expect(r.text).not.toContain(SIGNING_KEY);
    expect(r.text).not.toContain(ACCESS_KEY);

    const listed = await call("/tool", { method: "POST", body: { name: "pro_list_accounts", arguments: {} }, cookie });
    expect(listed.json.data.accounts).toHaveLength(1);
    expect(listed.text).not.toContain(SIGNING_KEY);
  });

  it("then lets the panel run the connection check through the tool endpoint", async () => {
    const cookie = await signIn();
    await call("/pro-account", { method: "POST", body: good, cookie });
    const r = await call("/tool", { method: "POST", body: { name: "diagnose_pro", arguments: { account_id: "pro-sklep-glowny" } }, cookie });
    expect(r.json.isError).toBe(false);
    expect(r.json.data).toMatchObject({ ok: true, verdict: "ok" });
    expect(fake.requests[0]!.signatureOk).toBe(true);
  });

  it("replaces the token of an existing account", async () => {
    const cookie = await signIn();
    await call("/pro-account", { method: "POST", body: good, cookie });
    const r = await call("/pro-account", { method: "POST", body: { ...good, accountId: "pro-sklep-glowny", env: "production", token: "NEW,NEWKEY" }, cookie });
    expect(r.status).toBe(200);
    expect(r.json.account).toMatchObject({ id: "pro-sklep-glowny", env: "production" });
    const listed = await call("/tool", { method: "POST", body: { name: "pro_list_accounts", arguments: {} }, cookie });
    expect(listed.json.data.accounts).toHaveLength(1);
  });

  it.each([
    ["an unknown environment", { ...good, env: "staging" }, /sandbox or production/],
    ["a token with no comma", { ...good, token: "justonepart" }, /<access_key>,<signing_key>/],
    ["no name", { ...good, label: "" }, /1 to 60/],
    ["an unknown account id", { ...good, accountId: "pro-nope" }, /Unknown/],
  ])("answers 400 for %s", async (_name, body, message) => {
    const cookie = await signIn();
    const r = await call("/pro-account", { method: "POST", body, cookie });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe("invalid_input");
    expect(r.json.message).toMatch(message);
    expect(r.text).not.toContain("justonepart");
  });

  it("does not quote a broken request body, which could contain the token", async () => {
    const cookie = await signIn();
    const r = await call("/pro-account", { method: "POST", rawBody: `{"label":"A","env":"sandbox","token":"${ACCESS_KEY},${SIGNING_KEY}"`, cookie });
    expect(r.status).toBe(400);
    expect(r.json.message).toBe("The request body is not valid JSON.");
    expect(r.text).not.toContain(SIGNING_KEY);
    expect(r.text).not.toContain(ACCESS_KEY);
  });

  it("explains a missing ENCRYPTION_KEY instead of storing the token in the clear", async () => {
    ({ fake } = setupPro({ ADMIN_PASSWORD: "panel-pass", ENCRYPTION_KEY: undefined }));
    const cookie = await signIn();
    const r = await call("/pro-account", { method: "POST", body: good, cookie });
    expect(r.status).toBe(503);
    expect(r.json.error).toBe("no_encryption");
    const listed = await call("/tool", { method: "POST", body: { name: "pro_list_accounts", arguments: {} }, cookie });
    expect(listed.json.data.accounts).toEqual([]);
  });
});

describe("feature flags", () => {
  it("tells the page which features exist", async () => {
    const cookie = await signIn();
    expect((await call("/me", { cookie })).json.features).toEqual({ pro: true, unofficial: true });
    ({ fake } = setupPro({ ADMIN_PASSWORD: "panel-pass", ENABLE_UNOFFICIAL: undefined }));
    const cookie2 = await signIn();
    expect((await call("/me", { cookie: cookie2 })).json.features).toEqual({ pro: true, unofficial: false });
  });

  it("hides the unofficial tools from the panel too, by default", async () => {
    ({ fake } = setupPro({ ADMIN_PASSWORD: "panel-pass", ENABLE_UNOFFICIAL: undefined }));
    const cookie = await signIn();
    const names = (await call("/tools", { cookie })).json.tools.map((t: { name: string }) => t.name);
    expect(names).toContain("diagnose_pro");
    expect(names).not.toContain("like_item");
    const r = await call("/tool", { method: "POST", body: { name: "like_item", arguments: { item_id: "1", confirm: true } }, cookie });
    expect(r.status).toBe(404);
    expect(r.json.error).toBe("unknown_tool");
  });
});


describe("ontology for the listing form", () => {
  it("serves the leaf categories and dictionaries, cached after the first call", async () => {
    const cookie = await signIn();
    expect((await call("/pro-ontology")).status).toBe(401);
    await call("/pro-account", { method: "POST", body: good, cookie });

    const first = await call("/pro-ontology?account=pro-sklep-glowny", { cookie });
    expect(first.status).toBe(200);
    expect(first.json.fromCache).toBe(false);
    expect(first.json.leaves.map((l: { id: number }) => l.id)).toEqual([1234, 1235]);
    expect(first.json.leaves[1]).toMatchObject({ path: "Kobiety › Odzież wierzchnia › Płaszcze", disabledFields: ["brand"], sizeGroupIds: [4] });
    expect(first.json.colors).toEqual([{ id: 9, title: "Niebieski" }, { id: 12, title: "Czarny" }]);
    expect(first.json.sizeGroups).toEqual([{ id: 4, sizes: [{ id: 206, title: "S" }, { id: 207, title: "M" }] }]);

    const second = await call("/pro-ontology?account=pro-sklep-glowny", { cookie });
    expect(second.json.fromCache).toBe(true);
    expect((await call("/pro-ontology?account=pro-sklep-glowny&refresh=1", { cookie })).json.fromCache).toBe(false);
  });

  it("explains a missing account and passes on a refused token", async () => {
    const cookie = await signIn();
    const none = await call("/pro-ontology", { cookie });
    expect(none.status).toBe(400);
    expect(none.json.message).toMatch(/Konta/);

    await call("/pro-account", { method: "POST", body: { ...good, token: `${ACCESS_KEY},wrong-key` }, cookie });
    const refused = await call("/pro-ontology?account=pro-sklep-glowny", { cookie });
    expect(refused.status).toBe(502);
    expect(refused.json).toMatchObject({ error: "auth", code: "INVALID_SIGNATURE" });
    expect(refused.text).not.toContain("wrong-key");
  });
});

describe("shipping label download", () => {
  it("streams the PDF with download headers, and answers 404 JSON before the label exists", async () => {
    const cookie = await signIn();
    expect((await call("/pro-label?order=1")).status).toBe(401);
    await call("/pro-account", { method: "POST", body: good, cookie });
    const ready = fake.addOrder({ labelReady: true });
    const early = fake.addOrder({ labelReady: false });

    const res = await fetch(`${base}/api/app/pro-label?account=pro-sklep-glowny&order=${ready.id}`, { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toBe(`attachment; filename="label_${ready.id}.pdf"`);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
    expect(Number(res.headers.get("content-length"))).toBe(bytes.length);

    const notYet = await call(`/pro-label?account=pro-sklep-glowny&order=${early.id}`, { cookie });
    expect(notYet.status).toBe(404);
    expect(notYet.json).toMatchObject({ error: "not_found", code: "ORDER_NOT_FOUND" });
    expect((await call("/pro-label?account=pro-sklep-glowny&order=1/../2", { cookie })).status).toBe(400);
    expect((await call("/pro-label?account=pro-sklep-glowny", { cookie })).status).toBe(400);
  });
});

describe("photo upload", () => {
  const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Array(64).fill(1)]).toString("base64");
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array(64).fill(2)]).toString("base64");
  const WEBP = Buffer.from(["RIFF", "\0\0\0\0", "WEBP", "VP8 "].join(""), "binary").toString("base64");

  beforeEach(() => {
    put.mockClear();
  });

  it("is switched off until a Blob store is connected, and says how to connect one", async () => {
    const cookie = await signIn();
    expect((await call("/me", { cookie })).json.setup.photoUpload).toBe(false);
    const r = await call("/pro-upload", { method: "POST", body: { base64: JPEG }, cookie });
    expect(r.status).toBe(503);
    expect(r.json.error).toBe("blob_not_configured");
    expect(r.json.message).toMatch(/BLOB_READ_WRITE_TOKEN/);
    expect(put).not.toHaveBeenCalled();
  });

  it("stores a real image publicly and returns its address", async () => {
    ({ fake } = setupPro({ ADMIN_PASSWORD: "panel-pass", BLOB_READ_WRITE_TOKEN: "blob-token" }));
    const cookie = await signIn();
    expect((await call("/me", { cookie })).json.setup.photoUpload).toBe(true);
    for (const [data, type, ext] of [[JPEG, "image/jpeg", "jpg"], [PNG, "image/png", "png"], [`data:image/jpeg;base64,${JPEG}`, "image/jpeg", "jpg"]] as const) {
      const r = await call("/pro-upload", { method: "POST", body: { base64: data }, cookie });
      expect(r.status).toBe(200);
      expect(r.json).toMatchObject({ contentType: type });
      expect(r.json.url).toMatch(new RegExp(`^https://store123\\.public\\.blob\\.vercel-storage\\.com/pro-photos/\\d{4}-\\d{2}/[0-9a-f]{24}\\.${ext}$`));
    }
    const [pathname, , options] = put.mock.calls[0]!;
    expect(options).toMatchObject({ access: "public", contentType: "image/jpeg", addRandomSuffix: false, allowOverwrite: false, token: "blob-token" });
    expect(String(pathname)).toMatch(/^pro-photos\//);
  });

  it("reads the format from the bytes, not from what the browser says, and refuses everything else", async () => {
    ({ fake } = setupPro({ ADMIN_PASSWORD: "panel-pass", BLOB_READ_WRITE_TOKEN: "blob-token" }));
    const cookie = await signIn();
    const html = Buffer.from("<html><script>alert(1)</script></html>").toString("base64");
    for (const [name, body, message] of [
      ["html pretending to be an image", { base64: html, mime: "image/jpeg" }, /Only JPEG, PNG and WebP/],
      ["not base64", { base64: "!!!not base64!!!" }, /not valid base64/],
      ["empty", { base64: "" }, /not valid base64/],
      ["too large", { base64: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(3_100_000)]).toString("base64") }, /limit is 3000000/],
    ] as const) {
      const r = await call("/pro-upload", { method: "POST", body, cookie });
      expect(r.status, name).toBe(400);
      expect(r.json.message, name).toMatch(message);
    }
    expect(put).not.toHaveBeenCalled();
  });

  it("needs a session and the panel's own origin", async () => {
    ({ fake } = setupPro({ ADMIN_PASSWORD: "panel-pass", BLOB_READ_WRITE_TOKEN: "blob-token" }));
    expect((await call("/pro-upload", { method: "POST", body: { base64: JPEG } })).status).toBe(401);
    const cookie = await signIn();
    expect((await call("/pro-upload", { method: "POST", body: { base64: JPEG }, cookie, origin: "https://evil.example" })).status).toBe(403);
    expect(put).not.toHaveBeenCalled();
  });
});
