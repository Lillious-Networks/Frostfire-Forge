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
