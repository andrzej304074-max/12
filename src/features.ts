import { getConfig } from "./config.js";

/**
 * Feature switches.
 *
 * The tools and panel views built on Vinted's unofficial consumer API
 * (research, watched sellers, likes and offers, the inbox) are hidden unless
 * ENABLE_UNOFFICIAL=true. The official Pro Integrations API does not cover
 * them, a server cannot reach that API through Vinted's bot protection, and
 * the Pro documentation says automating a consumer account breaks Vinted's
 * terms.
 */
export function unofficialEnabled(): boolean {
  return getConfig().unofficialEnabled;
}
