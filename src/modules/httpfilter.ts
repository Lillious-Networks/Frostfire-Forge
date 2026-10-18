// What the game server's HTTP API refuses before a request reaches it: more
// than `max` requests from one address in a window (settings.json
// webserverRatelimit), and any path with a segment named in
// src/config/security.cfg (probes for .env, wp-admin and the like).

export interface HttpFilterOptions {
  enabled: boolean;
  /** The window, in milliseconds. */
  windowMs: number;
  max: number;
  /** Path segments refused outright, compared without case. ".env" also covers ".env.*". */
  blockedSegments: string[];
}

/**
 * settings.json's webserverRatelimit.windowMs. The generated value is 5, which
 * as milliseconds would allow nothing: a value under 1000 is read as seconds.
 */
export function windowFromSettings(value: unknown): number {
  const n = Number(value);
  if (!(n > 0)) return 60_000;
  return n < 1000 ? n * 1000 : n;
}

/** The segments a security.cfg lists: one a line, `#` lines and blank lines left out. */
export function blockedSegmentsFrom(text: string): string[] {
  return text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#")).map((line) => line.toLowerCase());
}

export function createHttpFilter(options: HttpFilterOptions) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  let lastPrune = 0;
  const blocked = new Set(options.blockedSegments.map((segment) => segment.toLowerCase()));

  const isBlockedPath = (pathname: string) =>
    pathname.split("/").filter(Boolean).some((segment) => {
      let lower: string;
      try {
        lower = decodeURIComponent(segment).toLowerCase();
      } catch {
        lower = segment.toLowerCase();
      }
      return blocked.has(lower) || (blocked.has(".env") && lower.startsWith(".env."));
    });

  return (req: Request, ip: string, now = Date.now()): Response | null => {
    let pathname = "/";
    try {
      pathname = new URL(req.url).pathname;
    } catch {
      return new Response("Bad request", { status: 400 });
    }
    if (blocked.size > 0 && isBlockedPath(pathname)) return new Response("Not found", { status: 404 });

    if (!options.enabled || !(options.max > 0)) return null;
    if (now - lastPrune > options.windowMs) {
      lastPrune = now;
      for (const [key, entry] of hits) if (entry.resetAt <= now) hits.delete(key);
    }
    const key = ip || "unknown";
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + options.windowMs };
      hits.set(key, entry);
    }
    entry.count++;
    if (entry.count > options.max) {
      const retry = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
      return new Response("Too many requests", { status: 429, headers: { "Retry-After": String(retry) } });
    }
    return null;
  };
}
