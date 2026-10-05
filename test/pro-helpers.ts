import { createFakePro, type FakePro } from "../scripts/fake-pro.js";
import { saveProAccount } from "../src/pro/accounts.js";
import { resetProClientCache } from "../src/pro/client.js";
import { freshEnv, mockFetch } from "./helpers.js";

export const ACCESS_KEY = "ACCESSKEY123";
export const SIGNING_KEY = "signing-secret-xyz";
export const PRO_TOKEN = `${ACCESS_KEY},${SIGNING_KEY}`;

/**
 * A clean environment with `fetch` replaced by the fake Pro API. Nothing in a
 * test using this can reach the network. Pass `handler` to intercept requests
 * before the fake sees them (to script a failure).
 */
export function setupPro(
  extraEnv: Record<string, string | undefined> = {},
  handler?: (url: URL, init: RequestInit | undefined, fake: FakePro) => Response | undefined | Promise<Response | undefined>,
) {
  freshEnv(extraEnv);
  resetProClientCache();
  const fake = createFakePro({ accessKey: ACCESS_KEY, signingKey: SIGNING_KEY });
  const net = mockFetch(async (url, init) => {
    if (handler) {
      const scripted = await handler(url, init, fake);
      if (scripted) return scripted;
    }
    if (/(^|\.)vinted\.com$/.test(url.hostname)) return fake.handle(url, init);
    return new Response("unexpected host in a test", { status: 599 });
  });
  return { fake, net };
}

export async function addAccount(label = "Test", env: "sandbox" | "production" = "sandbox", token = PRO_TOKEN) {
  return saveProAccount({ label, env, token });
}
