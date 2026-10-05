import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { X509Certificate, createHash } from "crypto";
import {
  generateLocalCertificate,
  computeCertificateHash,
  certificateSupportsPinning,
  certificateNeedsRegeneration,
  ensureLocalCertificate,
  getCertificateStatus,
  certificateSanHostnames,
} from "../utility/local_cert";

process.env.SKIP_CERT_TRUST = "true";

test("generateLocalCertificate produces a pin-suitable ECDSA cert", async () => {
  const generated = await generateLocalCertificate();

  const cert = new X509Certificate(generated.certPem);

  expect(cert.verify(cert.publicKey)).toBe(true);
  expect((cert.publicKey as any).asymmetricKeyType).toBe("ec");
  expect(cert.subjectAltName).toContain("localhost");
  expect(cert.subjectAltName).toContain("127.0.0.1");

  const now = Date.now();
  expect(now).toBeGreaterThanOrEqual(Date.parse(cert.validFrom));
  expect(now).toBeLessThanOrEqual(Date.parse(cert.validTo));

  const validityDays = (Date.parse(cert.validTo) - Date.parse(cert.validFrom)) / 86400000;
  expect(validityDays).toBeLessThanOrEqual(14);
});

test("computeCertificateHash returns the SHA-256 of the DER certificate", async () => {
  const generated = await generateLocalCertificate();

  const cert = new X509Certificate(generated.certPem);
  const expected = createHash("sha256").update(cert.raw).digest("base64");

  expect(generated.hash).toBe(expected);
  expect(computeCertificateHash(generated.certPem)).toBe(expected);
});

test("generated certificate supports pinning and does not need regeneration", async () => {
  const generated = await generateLocalCertificate();

  expect(certificateSupportsPinning(generated.certPem)).toBe(true);
  expect(certificateNeedsRegeneration(generated.certPem)).toBe(false);
});

test("generated certificate omits NULL signature-algorithm parameters (RFC 5758)", async () => {
  const forge = await import("node-forge");
  const generated = await generateLocalCertificate();

  const decoded = forge.pem.decode(generated.certPem);
  expect(decoded.length).toBeGreaterThan(0);

  const certAsn1 = forge.asn1.fromDer(decoded[0].body) as any;
  const tbs = certAsn1.value[0];
  const outerSigAlg = certAsn1.value[1];
  const tbsSigAlg = tbs.value[2];

  for (const sigAlg of [outerSigAlg, tbsSigAlg]) {
    expect(Array.isArray(sigAlg.value)).toBe(true);
    expect(sigAlg.value.length).toBe(1);
  }
});

test("garbage PEM is flagged for regeneration", () => {
  expect(certificateNeedsRegeneration("not a certificate")).toBe(true);
  expect(certificateSupportsPinning("not a certificate")).toBe(false);
});

test("getCertificateStatus reports a fresh self-signed cert truthfully", async () => {
  const generated = await generateLocalCertificate();
  const status = getCertificateStatus(generated.certPem);

  expect(status.parseable).toBe(true);
  expect(status.selfSigned).toBe(true);
  expect(status.supportsPinning).toBe(true);
  expect(status.needsRegeneration).toBe(false);
  expect(status.expired).toBe(false);
  expect(status.validTo).not.toBeNull();
  expect(status.daysRemaining).toBeGreaterThan(7);
});

// Regression test for the outage where an expired CA-signed certificate was
// reported as "already valid": the status must say expired even though the
// auto-regenerator deliberately leaves CA-signed files alone.
test("getCertificateStatus reports expiry on CA-signed certs that needRegeneration ignores", async () => {
  const forge = await import("node-forge");

  // Throwaway RSA CA plus an RSA leaf (all-RSA so this forge build, which
  // cannot parse EC public keys, can build and re-sign both).
  const caKeys = forge.pki.rsa.generateKeyPair({ bits: 1024 });
  const ca = (forge.pki as any).createCertificate();
  ca.serialNumber = "01";
  ca.validity.notBefore = new Date(Date.now() - 86400000);
  ca.validity.notAfter = new Date(Date.now() + 86400000);
  ca.setSubject([{ shortName: "CN", value: "test-ca" }]);
  ca.setIssuer([{ shortName: "CN", value: "test-ca" }]);
  ca.publicKey = caKeys.publicKey;
  ca.setExtensions([{ name: "basicConstraints", cA: true }]);
  ca.sign(caKeys.privateKey, (forge.md as any).sha256.create());
  const caPem = forge.pki.certificateToPem(ca);
  const caX509 = new X509Certificate(caPem);

  const leafKeys = forge.pki.rsa.generateKeyPair({ bits: 1024 });
  const leaf = (forge.pki as any).createCertificate();
  leaf.serialNumber = "02";
  leaf.validity.notBefore = new Date(Date.now() - 3600000);
  leaf.validity.notAfter = new Date(Date.now() + 86400000);
  leaf.setSubject([{ shortName: "CN", value: "localhost" }]);
  leaf.setIssuer(ca.subject.attributes);
  leaf.publicKey = leafKeys.publicKey;
  leaf.setExtensions([
    { name: "basicConstraints", cA: false },
    {
      name: "subjectAltName",
      altNames: [
        { type: 2, value: "localhost" },
        { type: 7, ip: "127.0.0.1" },
      ],
    },
  ]);
  leaf.sign(caKeys.privateKey, (forge.md as any).sha256.create());
  const leafPem = forge.pki.certificateToPem(leaf);

  // Sanity: the fixture really is a CA-signed leaf.
  expect(new X509Certificate(leafPem).verify(caX509.publicKey)).toBe(true);

  const fresh = getCertificateStatus(leafPem);
  expect(fresh.parseable).toBe(true);
  expect(fresh.selfSigned).toBe(false);
  expect(fresh.expired).toBe(false);
  // CA-signed files are never auto-replaced, even when that hides expiry.
  expect(certificateNeedsRegeneration(leafPem)).toBe(false);

  // Backdate the leaf past expiry: status must flip to expired.
  const expiredLeaf = forge.pki.certificateFromPem(leafPem) as any;
  expiredLeaf.validity.notBefore = new Date(Date.now() - 3 * 86400000);
  expiredLeaf.validity.notAfter = new Date(Date.now() - 86400000);
  expiredLeaf.sign(caKeys.privateKey, (forge.md as any).sha256.create());
  const expiredPem = forge.pki.certificateToPem(expiredLeaf);

  const status = getCertificateStatus(expiredPem);
  expect(status.parseable).toBe(true);
  expect(status.selfSigned).toBe(false);
  expect(status.expired).toBe(true);
  expect(status.supportsPinning).toBe(false);
  expect((status.daysRemaining ?? 0)).toBeLessThan(0);
  // The trap: regeneration still says false for CA-signed files.
  expect(certificateNeedsRegeneration(expiredPem)).toBe(false);
});

test("certificateSanHostnames lists SAN names in the form the scripts take them", async () => {
  const generated = await generateLocalCertificate({
    hostnames: ["localhost", "127.0.0.1", "::1", "192.168.40.15", "frostfire-forge-dev"],
  });

  // IPv6 comes back compressed, not as the "0:0:0:0:0:0:0:1" X509Certificate prints.
  expect(certificateSanHostnames(generated.certPem)).toEqual([
    "localhost",
    "127.0.0.1",
    "::1",
    "192.168.40.15",
    "frostfire-forge-dev",
  ]);
  expect(certificateSanHostnames("not a certificate")).toEqual([]);
});

// Regression test for the "Failed to fetch WebTransport certificate hash"
// outage: bare `bun renew-lan-cert` loads .env.development, whose
// PUBLIC_HOST/SERVER_HOST lack the LAN address a server started with
// .env.production advertises. The renewal must keep the names already on the
// certificate it replaces instead of silently dropping them.
test("renew-lan-cert keeps the SAN names of the certificate it replaces", async () => {
  const forge = await import("node-forge");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "renew-lan-cert-test-"));
  const certPath = path.join(dir, "cert.pem");
  const keyPath = path.join(dir, "key.pem");
  const caPath = path.join(dir, "cert.ca-bundle");
  const caKeyPath = path.join(dir, "rootCA-key.pem");

  const caKeys = forge.pki.rsa.generateKeyPair({ bits: 1024 });
  const ca = (forge.pki as any).createCertificate();
  ca.serialNumber = "01";
  ca.validity.notBefore = new Date(Date.now() - 86400000);
  ca.validity.notAfter = new Date(Date.now() + 30 * 86400000);
  ca.setSubject([{ shortName: "CN", value: "test-ca" }]);
  ca.setIssuer([{ shortName: "CN", value: "test-ca" }]);
  ca.publicKey = caKeys.publicKey;
  ca.setExtensions([{ name: "basicConstraints", cA: true }]);
  ca.sign(caKeys.privateKey, (forge.md as any).sha256.create());
  fs.writeFileSync(caPath, forge.pki.certificateToPem(ca));
  fs.writeFileSync(caKeyPath, forge.pki.privateKeyToPem(caKeys.privateKey));

  const previous = await generateLocalCertificate({
    hostnames: ["localhost", "127.0.0.1", "::1", "192.168.40.15"],
  });
  fs.writeFileSync(certPath, previous.certPem);
  fs.writeFileSync(keyPath, previous.keyPem);

  const proc = Bun.spawn(
    [
      process.execPath,
      path.join(import.meta.dir, "../utility/renew_lan_cert.ts"),
      "--cert", certPath,
      "--key", keyPath,
      "--ca", caPath,
      "--ca-key", caKeyPath,
    ],
    {
      env: { ...process.env, PUBLIC_HOST: "127.0.0.1", SERVER_HOST: "frostfire-forge-dev" },
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const exitCode = await proc.exited;
  expect(exitCode).toBe(0);

  const renewedPem = fs.readFileSync(certPath, "utf8");
  expect(renewedPem).not.toBe(previous.certPem);
  expect(certificateSanHostnames(renewedPem)).toEqual([
    "localhost",
    "127.0.0.1",
    "::1",
    "192.168.40.15",
    "frostfire-forge-dev",
  ]);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("ensureLocalCertificate writes files when missing and is idempotent afterwards", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "local-cert-test-"));
  const certPath = path.join(dir, "cert.pem");
  const keyPath = path.join(dir, "key.pem");
  const caPath = path.join(dir, "cert.ca-bundle");

  const first = await ensureLocalCertificate({ certPath, keyPath, caPath });
  expect(first).not.toBeNull();

  const certMtime = fs.statSync(certPath).mtimeMs;
  const keyMtime = fs.statSync(keyPath).mtimeMs;

  await new Promise((resolve) => setTimeout(resolve, 10));

  const second = await ensureLocalCertificate({ certPath, keyPath, caPath });
  expect(second).toBeNull();
  expect(fs.statSync(certPath).mtimeMs).toBe(certMtime);
  expect(fs.statSync(keyPath).mtimeMs).toBe(keyMtime);

  const certPem = fs.readFileSync(certPath, "utf8");
  expect(certificateSupportsPinning(certPem)).toBe(true);
  expect(fs.readFileSync(caPath, "utf8")).toBe("");

  fs.rmSync(dir, { recursive: true, force: true });
});

// Regression test for the certificate (and its pin hash) being regenerated on
// every server start: server.ts always asks for "::1", which X509Certificate
// prints expanded ("0:0:0:0:0:0:0:1") under Bun, so a textual match against
// the SAN never found it and the certificate was never reused.
test("ensureLocalCertificate reuses a certificate that already covers the requested hostnames", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "local-cert-test-"));
  const certPath = path.join(dir, "cert.pem");
  const keyPath = path.join(dir, "key.pem");
  const caPath = path.join(dir, "cert.ca-bundle");
  const hostnames = ["localhost", "127.0.0.1", "::1"];

  const first = await ensureLocalCertificate({ certPath, keyPath, caPath, hostnames });
  expect(first).not.toBeNull();

  const certMtime = fs.statSync(certPath).mtimeMs;
  const keyMtime = fs.statSync(keyPath).mtimeMs;

  await new Promise((resolve) => setTimeout(resolve, 10));

  const second = await ensureLocalCertificate({ certPath, keyPath, caPath, hostnames });
  expect(second).toBeNull();
  expect(fs.statSync(certPath).mtimeMs).toBe(certMtime);
  expect(fs.statSync(keyPath).mtimeMs).toBe(keyMtime);

  fs.rmSync(dir, { recursive: true, force: true });
});
