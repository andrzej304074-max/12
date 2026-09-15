import type { ToolResult } from "../protocol.js";

/** A JSON Schema object, as sent to MCP clients verbatim. */
export type JsonSchema = Record<string, unknown>;

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface Tool {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  annotations?: ToolAnnotations;
  handler(args: Record<string, unknown>): Promise<ToolResult>;
}

/** Raised for bad tool arguments; the dispatcher turns it into a tool error. */
export class ArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArgumentError";
  }
}

export function requireString(
  args: Record<string, unknown>,
  name: string,
): string {
  const value = args[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new ArgumentError(`"${name}" is required and must be a non-empty string.`);
  }
  return value.trim();
}

export function optString(
  args: Record<string, unknown>,
  name: string,
): string | undefined {
  const value = args[name];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") {
    throw new ArgumentError(`"${name}" must be a string.`);
  }
  return value.trim();
}

export function optNumber(
  args: Record<string, unknown>,
  name: string,
): number | undefined {
  const value = args[name];
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    throw new ArgumentError(`"${name}" must be a number.`);
  }
  return parsed;
}

export function optNumberArray(
  args: Record<string, unknown>,
  name: string,
): number[] | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw new ArgumentError(`"${name}" must be an array of numbers.`);
  }
  return value.map((entry) => {
    const parsed = typeof entry === "number" ? entry : Number(entry);
    if (!Number.isFinite(parsed)) {
      throw new ArgumentError(`"${name}" must contain only numbers.`);
    }
    return parsed;
  });
}

export function optBoolean(
  args: Record<string, unknown>,
  name: string,
): boolean | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") {
    throw new ArgumentError(`"${name}" must be a boolean.`);
  }
  return value;
}
