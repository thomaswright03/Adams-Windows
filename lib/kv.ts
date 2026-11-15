/** A tiny key-value store: Upstash Redis in production (added from the
 * Vercel Marketplace, which sets the KV_REST_API_* or UPSTASH_REDIS_REST_*
 * variables), and an in-memory copy for tests. */

export interface Kv {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, opts?: { nx?: boolean; exSeconds?: number }): Promise<boolean>;
  del(key: string): Promise<void>;
  incr(key: string, exSeconds?: number): Promise<number>;
  sadd(key: string, member: string): Promise<void>;
  srem(key: string, member: string): Promise<void>;
  smembers(key: string): Promise<string[]>;
  sismember(key: string, member: string): Promise<boolean>;
  rpush(key: string, value: string): Promise<void>;
  lrange(key: string, start: number, stop: number): Promise<string[]>;
}

export class MemoryKv implements Kv {
  strings = new Map<string, string>();
  sets = new Map<string, Set<string>>();
  lists = new Map<string, string[]>();

  async get(key: string) {
    return this.strings.get(key) ?? null;
  }
  async set(key: string, value: string, opts: { nx?: boolean } = {}) {
    if (opts.nx && this.strings.has(key)) return false;
    this.strings.set(key, value);
    return true;
  }
  async del(key: string) {
    this.strings.delete(key);
    this.sets.delete(key);
    this.lists.delete(key);
  }
  async incr(key: string) {
    const n = Number(this.strings.get(key) ?? "0") + 1;
    this.strings.set(key, String(n));
    return n;
  }
  async sadd(key: string, member: string) {
    if (!this.sets.has(key)) this.sets.set(key, new Set());
    this.sets.get(key)!.add(member);
  }
  async srem(key: string, member: string) {
    this.sets.get(key)?.delete(member);
  }
  async smembers(key: string) {
    return [...(this.sets.get(key) ?? [])];
  }
  async sismember(key: string, member: string) {
    return this.sets.get(key)?.has(member) ?? false;
  }
  async rpush(key: string, value: string) {
    if (!this.lists.has(key)) this.lists.set(key, []);
    this.lists.get(key)!.push(value);
  }
  async lrange(key: string, start: number, stop: number) {
    const list = this.lists.get(key) ?? [];
    const end = stop < 0 ? list.length + stop + 1 : stop + 1;
    const from = start < 0 ? Math.max(0, list.length + start) : start;
    return list.slice(from, end);
  }
}

export class UpstashKv implements Kv {
  constructor(private url: string, private token: string) {}

  private async cmd(...args: Array<string | number>): Promise<any> {
    const res = await fetch(this.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(args.map(String)),
    });
    const data = (await res.json().catch(() => ({}))) as { result?: unknown; error?: string };
    if (!res.ok || data.error) throw new Error(`Redis ${args[0]} failed: ${res.status} ${data.error ?? ""}`);
    return data.result;
  }

  async get(key: string) {
    return (await this.cmd("GET", key)) ?? null;
  }
  async set(key: string, value: string, opts: { nx?: boolean; exSeconds?: number } = {}) {
    const args: Array<string | number> = ["SET", key, value];
    if (opts.exSeconds) args.push("EX", opts.exSeconds);
    if (opts.nx) args.push("NX");
    return (await this.cmd(...args)) === "OK";
  }
  async del(key: string) {
    await this.cmd("DEL", key);
  }
  async incr(key: string, exSeconds?: number) {
    const n = Number(await this.cmd("INCR", key));
    if (exSeconds && n === 1) await this.cmd("EXPIRE", key, exSeconds);
    return n;
  }
  async sadd(key: string, member: string) {
    await this.cmd("SADD", key, member);
  }
  async srem(key: string, member: string) {
    await this.cmd("SREM", key, member);
  }
  async smembers(key: string) {
    return ((await this.cmd("SMEMBERS", key)) as string[]) ?? [];
  }
  async sismember(key: string, member: string) {
    return Number(await this.cmd("SISMEMBER", key, member)) === 1;
  }
  async rpush(key: string, value: string) {
    await this.cmd("RPUSH", key, value);
  }
  async lrange(key: string, start: number, stop: number) {
    return ((await this.cmd("LRANGE", key, start, stop)) as string[]) ?? [];
  }
}

let shared: Kv | undefined;

export function getKv(): Kv {
  if (shared) return shared;
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error("No Redis configured: add Upstash Redis to the Vercel project (Storage tab).");
  shared = new UpstashKv(url, token);
  return shared;
}
