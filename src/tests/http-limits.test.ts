import { describe, expect, test } from "bun:test";
import { RateBucket } from "../socket/ratebucket";
import { blockedSegmentsFrom, createHttpFilter, windowFromSettings } from "../modules/httpfilter";

describe("a rate bucket", () => {
  test("lets a burst through, then the rate", () => {
    const bucket = new RateBucket(2, 3, 0);
    expect([bucket.take(0), bucket.take(0), bucket.take(0), bucket.take(0)]).toEqual([true, true, true, false]);
    // Half a second at two a second refills one.
    expect(bucket.take(500)).toBe(true);
    expect(bucket.take(500)).toBe(false);
  });

  test("no rate, or the benchmark's switch-off value, is no limit", () => {
    for (const bucket of [new RateBucket(NaN, NaN), new RateBucket(0, 10), new RateBucket(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)]) {
      for (let i = 0; i < 100; i++) expect(bucket.take(0)).toBe(true);
    }
  });
});

describe("the HTTP API's filter", () => {
  const request = (path: string) => new Request(`https://game.example${path}`);

  test("more than max requests from one address in the window are refused, others are not", () => {
    const filter = createHttpFilter({ enabled: true, windowMs: 1000, max: 2, blockedSegments: [] });
    expect(filter(request("/status"), "1.1.1.1", 0)).toBeNull();
    expect(filter(request("/status"), "1.1.1.1", 0)).toBeNull();
    expect(filter(request("/status"), "1.1.1.1", 0)?.status).toBe(429);
    expect(filter(request("/status"), "2.2.2.2", 0)).toBeNull();
    // A new window.
    expect(filter(request("/status"), "1.1.1.1", 1000)).toBeNull();
  });

  test("off, it counts nothing", () => {
    const filter = createHttpFilter({ enabled: false, windowMs: 1000, max: 1, blockedSegments: [] });
    for (let i = 0; i < 5; i++) expect(filter(request("/ping"), "1.1.1.1", 0)).toBeNull();
  });

  test("a path with a blocked segment is not served", () => {
    const filter = createHttpFilter({ enabled: false, windowMs: 1000, max: 1, blockedSegments: blockedSegmentsFrom("# Security Definitions\n.env\nwp-admin\n\n") });
    expect(filter(request("/.env"), "1.1.1.1")?.status).toBe(404);
    expect(filter(request("/a/.env.production"), "1.1.1.1")?.status).toBe(404);
    expect(filter(request("/WP-ADMIN/x"), "1.1.1.1")?.status).toBe(404);
    expect(filter(request("/status"), "1.1.1.1")).toBeNull();
  });

  test("the generated window of 5 is five seconds", () => {
    expect(windowFromSettings(5)).toBe(5000);
    expect(windowFromSettings(60_000)).toBe(60_000);
    expect(windowFromSettings(undefined)).toBe(60_000);
  });
});
