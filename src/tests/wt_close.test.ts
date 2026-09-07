import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startWebTransportServer } from "../socket/transport";
import { BenchmarkConnection } from "../utility/benchmark-transport";
import { generateLocalCertificate } from "../utility/local_cert";

test("WT session close fires onClose handler", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "wt-close-test-"));
  const certPath = path.join(tempDir, "cert.pem");
  const keyPath = path.join(tempDir, "key.pem");

  const generated = await generateLocalCertificate({ validityDays: 7 });
  fs.writeFileSync(certPath, generated.certPem);
  fs.writeFileSync(keyPath, generated.keyPem);

  const previousCertEnv = process.env.TLS_CERT_PATH;
  // Pin the generated cert via caPem (the strict verification path that
  // previously rejected forged certs with NULL signature-algorithm params).
  process.env.TLS_CERT_PATH = certPath;

  let closeCount = 0;
  let openCount = 0;

  const server = await startWebTransportServer({
    port: 3999,
    certPem: generated.certPem,
    keyPem: generated.keyPem,
    chatDecryptionKey: "test-key",
    maxFrameSize: 1024 * 1024,
    maxDatagramSize: 1200,
    authTimeoutMs: 10000,
    idleTimeoutMs: 30000,
    maxSessions: 10,
    rateLimits: {},
    handlers: {
      validateConnectionToken: () => true,
      onOpen: () => { openCount++; },
      onClose: () => { closeCount++; },
      onMessage: () => {},
    },
  } as any);

  try {
    await new Promise((resolve) => setTimeout(resolve, 500));

    const client = await BenchmarkConnection.connect(
      "https://127.0.0.1:3999",
      "test-secret"
    );

    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(openCount).toBe(1);

    client.close();

    await new Promise((resolve) => setTimeout(resolve, 2000));

    expect(closeCount).toBe(1);
  } finally {
    if (previousCertEnv === undefined) {
      delete process.env.TLS_CERT_PATH;
    } else {
      process.env.TLS_CERT_PATH = previousCertEnv;
    }
    try { server.stop(); } catch { /* ignore */ }
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}, 20000);
