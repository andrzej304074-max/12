import { unofficialEnabled } from "../../features.js";
import { actionTools } from "./actions.js";
import { inboxTools } from "./inbox.js";
import { listingTools } from "./listing.js";
import { monitorTools } from "./monitor.js";
import { opsTools } from "./ops.js";
import { proTools } from "./pro.js";
import { researchTools } from "./research.js";
import { sellingTools } from "./selling.js";
import type { Tool } from "./types.js";

/** Tools of the official Vinted Pro Integrations API: always available. */
export const officialTools: Tool[] = [...proTools];

/**
 * Tools built on Vinted's unofficial consumer API. Hidden unless
 * ENABLE_UNOFFICIAL=true (see src/features.ts): they are blocked for servers,
 * the official API does not cover them, and Vinted's Pro documentation says
 * automating a consumer account breaks its terms.
 */
export const unofficialTools: Tool[] = [
  ...researchTools,
  ...listingTools,
  ...monitorTools,
  ...actionTools,
  ...inboxTools,
  ...sellingTools,
  ...opsTools,
];

export const allTools: Tool[] = [...officialTools, ...unofficialTools];

const byName = new Map(allTools.map((tool) => [tool.name, tool]));
const unofficialNames = new Set(unofficialTools.map((tool) => tool.name));

/** The tools a client may see and call right now. */
export function activeTools(): Tool[] {
  return unofficialEnabled() ? allTools : officialTools;
}

export function findTool(name: string): Tool | undefined {
  const tool = byName.get(name);
  if (!tool) return undefined;
  return unofficialNames.has(name) && !unofficialEnabled() ? undefined : tool;
}

/** The tool list as MCP clients receive it, without the handlers. */
export function toolManifest() {
  return activeTools().map(({ name, title, description, inputSchema, annotations }) => ({
    name,
    title,
    description,
    inputSchema,
    ...(annotations ? { annotations } : {}),
  }));
}
