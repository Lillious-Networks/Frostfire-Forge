import { describe, expect, test } from "bun:test";
import { isLoopbackUrl, tlsFor } from "../modules/https_servers";

describe("server-to-server requests check the certificate", () => {
  test("except on loopback: the internal hop to this machine", () => {
    for (const url of ["https://127.0.0.1:9998/heartbeat", "https://127.8.9.10/x", "https://localhost:8082/map-checksums", "https://[::1]:8443/", "https://assets.localhost/"]) {
      expect(isLoopbackUrl(url)).toBe(true);
      expect(tlsFor(url).rejectUnauthorized).toBe(false);
    }
  });

  test("everywhere else, a LAN address included", () => {
    for (const url of ["https://192.168.40.15:9443/register", "https://gateway.example.com/heartbeat", "https://127.0.0.1.evil.example/", "https://10.0.0.5/", "not a url"]) {
      expect(isLoopbackUrl(url)).toBe(false);
    }
    expect(tlsFor("https://192.168.40.15:8443/update-map").rejectUnauthorized).toBe(true);
    expect(tlsFor("https://gateway.example.com/register").rejectUnauthorized).toBe(true);
  });
});
