class IpService {
  constructor(
    private allowed_ips: string[] = [],
    private blocked_ips: string[] = []
  ) {}

  whitelistAdd(ip: string): number {
    return this.allowed_ips.push(ip);
  }

  getWhitelistedIPs(): string[] {
    return this.allowed_ips;
  }

  blacklistAdd(ip: string): number {
    return this.blocked_ips.push(ip);
  }

  getBlacklistedIPs(): string[] {
    return this.blocked_ips;
  }

  blacklistRemove(ip: string): void {
    const index = this.blocked_ips.indexOf(ip);
    if (index > -1) {
      this.blocked_ips.splice(index, 1);
    }
  }

  whitelistRemove(ip: string): void {
    const index = this.allowed_ips.indexOf(ip);
    if (index > -1) {
      this.allowed_ips.splice(index, 1);
    }
  }
}

export const service: IpService = new IpService();
