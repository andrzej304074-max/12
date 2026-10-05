import type { Store } from "./index.js";

/**
 * Upstash Redis over its REST API.
 *
 * REST rather than a TCP client because serverless invocations are short lived
 * and cannot usefully pool connections.
 */
export class UpstashStore implements Store {
  readonly durable = true;

  constructor(
    private readonly url: string,
    private readonly token: string,
  ) {}

  private async command<T>(args: (string | number)[]): Promise<T> {
    const res = await fetch(this.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(args),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `Upstash ${args[0]} failed: ${res.status} ${body.slice(0, 200)}`,
      );
    }
    const payload = (await res.json()) as { result?: T; error?: string };
    if (payload.error) throw new Error(`Upstash error: ${payload.error}`);
    return payload.result as T;
  }

  async get<T>(key: string): Promise<T | null> {
    const raw = await this.command<string | null>(["GET", key]);
    if (raw === null || raw === undefined) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return raw as unknown as T;
    }
  }

  async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    const args: (string | number)[] = ["SET", key, JSON.stringify(value)];
    if (ttlSeconds) args.push("EX", Math.ceil(ttlSeconds));
    await this.command(args);
  }

  async setNx<T>(key: string, value: T, ttlSeconds?: number): Promise<boolean> {
    const args: (string | number)[] = ["SET", key, JSON.stringify(value), "NX"];
    if (ttlSeconds) args.push("EX", Math.ceil(ttlSeconds));
    return (await this.command<string | null>(args)) === "OK";
  }

  async del(key: string): Promise<void> {
    await this.command(["DEL", key]);
  }

  async sadd(key: string, ...members: string[]): Promise<void> {
    if (members.length === 0) return;
    await this.command(["SADD", key, ...members]);
  }

  async srem(key: string, ...members: string[]): Promise<void> {
    if (members.length === 0) return;
    await this.command(["SREM", key, ...members]);
  }

  async smembers(key: string): Promise<string[]> {
    return (await this.command<string[]>(["SMEMBERS", key])) ?? [];
  }

  async incr(key: string, ttlSeconds?: number): Promise<number> {
    const next = await this.command<number>(["INCR", key]);
    if (ttlSeconds && next === 1) {
      await this.command(["EXPIRE", key, Math.ceil(ttlSeconds)]);
    }
    return next;
  }
}
