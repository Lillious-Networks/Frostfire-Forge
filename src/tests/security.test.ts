import { expect, test } from "bun:test";

// Mock IP service
const whitelistedIPs: Set<string> = new Set();
const blacklistedIPs: Set<string> = new Set();

const service = {
  getWhitelistedIPs: () => whitelistedIPs,
  getBlacklistedIPs: () => blacklistedIPs,
  whitelistAdd: (ip: string) => whitelistedIPs.add(ip),
  whitelistRemove: (ip: string) => whitelistedIPs.delete(ip),
  blacklistAdd: (ip: string) => blacklistedIPs.add(ip),
  blacklistRemove: (ip: string) => blacklistedIPs.delete(ip),
};

// Mock database
const mockQuery = async (sql: string, params: any[]) => {
  if (sql.includes("SELECT * FROM blocked_ips")) {
    return Array.from(blacklistedIPs).map((ip) => ({ ip }));
  }
  if (sql.includes("SELECT * FROM allowed_ips")) {
    return Array.from(whitelistedIPs).map((ip) => ({ ip }));
  }
  if (sql.includes("INSERT INTO blocked_ips")) {
    const [ip] = params;
    blacklistedIPs.add(ip);
    return { affectedRows: 1 };
  }
  if (sql.includes("INSERT INTO allowed_ips")) {
    const [ip] = params;
    whitelistedIPs.add(ip);
    return { affectedRows: 1 };
  }
  if (sql.includes("DELETE FROM blocked_ips")) {
    const [ip] = params;
    blacklistedIPs.delete(ip);
    return { affectedRows: 1 };
  }
  if (sql.includes("DELETE FROM allowed_ips")) {
    const [ip] = params;
    whitelistedIPs.delete(ip);
    return { affectedRows: 1 };
  }
  return [];
};

const security = {
  blacklistAdd: async (ip: string) => {
    const result = (await mockQuery("INSERT INTO blocked_ips (ip) VALUES (?)", [ip])) as any;
    if (result.affectedRows > 0) {
      service.blacklistAdd(ip);
      return true;
    }
    return false;
  },

  whitelistAdd: async (ip: string) => {
    const result = (await mockQuery("INSERT INTO allowed_ips (ip) VALUES (?)", [ip])) as any;
    if (result.affectedRows > 0) {
      service.whitelistAdd(ip);
      return true;
    }
    return false;
  },

  blacklistRemove: async (ip: string) => {
    const result = (await mockQuery("DELETE FROM blocked_ips WHERE ip = ?", [ip])) as any;
    if (result.affectedRows > 0) {
      service.blacklistRemove(ip);
      return true;
    }
    return false;
  },

  whitelistRemove: async (ip: string) => {
    const result = (await mockQuery("DELETE FROM allowed_ips WHERE ip = ?", [ip])) as any;
    if (result.affectedRows > 0) {
      service.whitelistRemove(ip);
      return true;
    }
    return false;
  },

  isBlacklisted: (ip: string) => service.getBlacklistedIPs().has(ip),

  isWhitelisted: (ip: string) => service.getWhitelistedIPs().has(ip),
};

test("security.blacklistAdd adds IP to blacklist", async () => {
  await security.blacklistAdd("192.168.1.1");
  expect(security.isBlacklisted("192.168.1.1")).toBe(true);
});

test("security.whitelistAdd adds IP to whitelist", async () => {
  await security.whitelistAdd("10.0.0.1");
  expect(security.isWhitelisted("10.0.0.1")).toBe(true);
});

test("security.blacklistRemove removes IP from blacklist", async () => {
  await security.blacklistAdd("192.168.1.100");
  await security.blacklistRemove("192.168.1.100");
  expect(security.isBlacklisted("192.168.1.100")).toBe(false);
});

test("security.whitelistRemove removes IP from whitelist", async () => {
  await security.whitelistAdd("10.0.0.100");
  await security.whitelistRemove("10.0.0.100");
  expect(security.isWhitelisted("10.0.0.100")).toBe(false);
});

test("security.isBlacklisted returns false for non-blacklisted IP", async () => {
  const result = security.isBlacklisted("1.1.1.1");
  expect(result).toBe(false);
});

test("security.isWhitelisted returns false for non-whitelisted IP", async () => {
  const result = security.isWhitelisted("1.1.1.1");
  expect(result).toBe(false);
});

test("security handles multiple IPs", async () => {
  const ips = ["192.168.1.1", "192.168.1.2", "192.168.1.3"];
  for (const ip of ips) {
    await security.blacklistAdd(ip);
  }
  expect(security.isBlacklisted("192.168.1.1")).toBe(true);
  expect(security.isBlacklisted("192.168.1.2")).toBe(true);
  expect(security.isBlacklisted("192.168.1.3")).toBe(true);
});

test("security preserves IP data after add/remove cycle", async () => {
  const ip = "172.16.0.1";
  await security.whitelistAdd(ip);
  await security.whitelistRemove(ip);
  await security.whitelistAdd(ip);
  expect(security.isWhitelisted(ip)).toBe(true);
});
