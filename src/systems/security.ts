import query from "../controllers/sqldatabase";
import { service } from "../services/ip";
import log from "../modules/logger";
export const w_ips = service.getWhitelistedIPs();
export const b_ips = service.getBlacklistedIPs();

query("SELECT * FROM blocked_ips", [])
  .then((result: any) => {
    result.forEach((element: any) => {
      service.blacklistAdd(element.ip);
    });
  })
  .catch((err: any) => {
    if (err) {
      console.error("Error loading blocked IPs:", err);
    }
  });

query("SELECT * FROM allowed_ips", [])
  .then((result: any) => {
    result.forEach((element: any) => {
      service.whitelistAdd(element.ip);
    });
  })
  .catch((err: any) => {
    if (err) {
      console.error("Error loading allowed IPs:", err);
    }
  });

  export const blacklistAdd = async (ip: string) => {
    const result = await query("INSERT INTO blocked_ips (ip) VALUES (?)", [ip]) as any;

    if (result.affectedRows > 0) {
      log.info(`Added ${ip} to the blacklist`);
      service.blacklistAdd(ip);
    }
  }

  export const whitelistAdd = async (ip: string) => {
    const result = await query("INSERT INTO allowed_ips (ip) VALUES (?)", [ip]) as any;

    if (result.affectedRows > 0) {
      log.info(`Added ${ip} to the whitelist`);
      service.whitelistAdd(ip);
    }
  }

  export const blacklistRemove = async (ip: string) => {
    const result = await query("DELETE FROM blocked_ips WHERE ip = ?", [ip]) as any;

    if (result.affectedRows > 0) {
      log.info(`Removed ${ip} from the blacklist`);
      service.blacklistRemove(ip);
    }
  }

  export const whitelistRemove = async (ip: string) => {
    const result = await query("DELETE FROM allowed_ips WHERE ip = ?", [ip]) as any;

    if (result.affectedRows > 0) {
      log.info(`Removed ${ip} from the whitelist`);
      service.whitelistRemove(ip);
    }
  }
