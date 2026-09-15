import { listingTools } from "./listing.js";
import { monitorTools } from "./monitor.js";
import { opsTools } from "./ops.js";
import { researchTools } from "./research.js";
import type { Tool } from "./types.js";

export const allTools: Tool[] = [
  ...researchTools,
  ...listingTools,
  ...monitorTools,
  ...opsTools,
];

const byName = new Map(allTools.map((tool) => [tool.name, tool]));

export function findTool(name: string): Tool | undefined {
  return byName.get(name);
}

/** The tool list as MCP clients receive it, without the handlers. */
export function toolManifest() {
  return allTools.map(({ name, title, description, inputSchema, annotations }) => ({
    name,
    title,
    description,
    inputSchema,
    ...(annotations ? { annotations } : {}),
  }));
}
