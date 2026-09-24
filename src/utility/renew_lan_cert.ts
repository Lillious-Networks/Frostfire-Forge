import { webcrypto as crypto, X509Certificate, createPrivateKey, sign } from "crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildTbsCertificate,
  computeCertificateHash,
  getCertificateStatus,
  loadForge,
  positiveSerialHex,
  SHA256_WITH_RSA_OID,
} from "./local_cert.ts";

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index !== -1 ? process.argv[index + 1] : undefined;
}

function argValues(name: string): string[] {
  return process.argv
    .map((arg, index) => (arg === name ? process.argv[index + 1] : undefined))
    .filter((value): value is string => value !== undefined);
}

function defaultCaKeyPath(): string {
  if (process.platform === "win32") {
    return path.join(os.homedir(), "AppData", "Local", "mkcert", "rootCA-key.pem");
  }
  return path.join(os.homedir(), ".local", "share", "mkcert", "rootCA-key.pem");
}

function firstPemBlock(pem: string, label: string): string {
  const match = pem.match(/-----BEGIN [^-]*-----/);
  if (!match || !match[0].includes(label)) {
    throw new Error(`No ${label} block found in the CA file.`);
  }
  const start = match.index!;
  const endMarker = match[0].replace("BEGIN", "END");
  const end = pem.indexOf(endMarker, start);
  if (end === -1) {
    throw new Error(`Truncated ${label} block in the CA file.`);
  }
  return pem.slice(start, end + endMarker.length);
}

const certPath = argValue("--cert") || process.env.TLS_CERT_PATH;
const keyPath = argValue("--key") || process.env.TLS_KEY_PATH;
const caPath = argValue("--ca") || process.env.TLS_CA_PATH;
const caKeyPath = argValue("--ca-key") || process.env.LAN_CA_KEY_PATH || defaultCaKeyPath();
const validityDays = parseInt(argValue("--days") || "13", 10);

if (!certPath || !keyPath) {
  console.error("TLS_CERT_PATH and TLS_KEY_PATH must be set (or pass --cert/--key) so the renewed certificate lands where the server reads it.");
  process.exit(1);
}
if (!caPath || !fs.existsSync(caPath)) {
  console.error(`CA certificate not found at ${caPath || "(TLS_CA_PATH not set)"}. It must contain the local CA that phones trust (e.g. the mkcert rootCA.pem).`);
  process.exit(1);
}
if (!fs.existsSync(caKeyPath)) {
  console.error(`CA private key not found at ${caKeyPath}. Pass --ca-key or set LAN_CA_KEY_PATH (mkcert default: <CAROOT>/rootCA-key.pem, see \`mkcert -CAROOT\`).`);
  process.exit(1);
}
if (!Number.isInteger(validityDays) || validityDays < 1 || validityDays > 13) {
  console.error("--days must be between 1 and 13. Chromium pinning requires total validity <= 14 days.");
  process.exit(1);
}

// Same hostname set the server expects at startup: everything a browser
// might dial must be in the SAN, even when pinned.
const hostnames = ["localhost", "127.0.0.1", "::1"];
for (const host of [process.env.PUBLIC_HOST, process.env.SERVER_HOST, ...argValues("--host")]) {
  const trimmed = host?.trim();
  if (trimmed && !hostnames.includes(trimmed)) {
    hostnames.push(trimmed);
  }
}

const caPem = firstPemBlock(fs.readFileSync(caPath, "utf8"), "CERTIFICATE");
const caCert = new X509Certificate(caPem);
const caStatus = getCertificateStatus(caPem);
if (caStatus.expired) {
  console.error(`Local CA certificate expired on ${caStatus.validTo}. Reinstall/renew the CA itself (mkcert -install) before renewing leaves.`);
  process.exit(1);
}

const forge = await loadForge();

// The mkcert development CA is RSA; node:crypto signs the TBS directly so
// any RSA key encoding (PKCS#1/PKCS#8) works without forge key wrangling.
let caKey: ReturnType<typeof createPrivateKey>;
try {
  caKey = createPrivateKey(fs.readFileSync(caKeyPath, "utf8"));
} catch (error: any) {
  console.error(`Failed to load the CA private key: ${error?.message || error}`);
  process.exit(1);
}
if (caKey.asymmetricKeyType !== "rsa") {
  console.error(`Unsupported CA key type "${caKey.asymmetricKeyType}". This script signs with RSA CAs (mkcert default).`);
  process.exit(1);
}

const keyPair = (await crypto.subtle.generateKey(
  { name: "ECDSA", namedCurve: "P-256" },
  true,
  ["sign", "verify"]
)) as CryptoKeyPair;
const publicKeySpki = await crypto.subtle.exportKey("spki", keyPair.publicKey);

const { pki } = forge as any;
const caForgeCert = pki.certificateFromPem(caPem);

const cert: any = pki.createCertificate();
cert.serialNumber = positiveSerialHex();
cert.validity.notBefore = new Date();
cert.validity.notAfter = new Date(Date.now() + validityDays * 86400000);
cert.setSubject([{ shortName: "CN", value: "localhost" }]);
cert.setIssuer(caForgeCert.subject.attributes);
(cert as any).publicKey = publicKeySpki;
cert.setExtensions([
  { name: "basicConstraints", cA: false },
  { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
  {
    name: "subjectAltName",
    altNames: hostnames.map((host) => {
      const isIpv4 = /^(\d{1,3}\.){3}\d{1,3}$/.test(host);
      const isIpv6 = host.includes(":");
      return isIpv4 || isIpv6 ? { type: 7, ip: host } : { type: 2, value: host };
    }),
  },
  { name: "extKeyUsage", serverAuth: true },
]);

const tbsCertificate = buildTbsCertificate(
  forge,
  cert,
  publicKeySpki,
  SHA256_WITH_RSA_OID,
  true
);
const { asn1, util } = forge as any;
const tbsDer = Buffer.from(asn1.toDer(tbsCertificate).getBytes(), "binary");
const signature = sign("sha256", tbsDer, caKey);

const certificateAsn1 = asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
  tbsCertificate,
  asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OID, false, asn1.oidToDer(SHA256_WITH_RSA_OID).getBytes()),
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.NULL, false, ""),
  ]),
  asn1.create(
    asn1.Class.UNIVERSAL,
    asn1.Type.BITSTRING,
    false,
    String.fromCharCode(0x00) + signature.toString("binary")
  ),
]);

const certPemOut = forge.pem.encode({
  type: "CERTIFICATE",
  body: asn1.toDer(certificateAsn1).getBytes(),
});
const keyPemOut = forge.pem.encode({
  type: "PRIVATE KEY",
  body: new (util as any).ByteBuffer(await crypto.subtle.exportKey("pkcs8", keyPair.privateKey)).getBytes(),
});

// Verify before touching the live files: chains to the CA and is pinnable.
const renewed = new X509Certificate(certPemOut);
if (!renewed.verify(caCert.publicKey)) {
  console.error("Renewed certificate does not verify against the CA. Live files left untouched.");
  process.exit(1);
}
const status = getCertificateStatus(certPemOut);
if (!status.supportsPinning || status.selfSigned) {
  console.error("Renewed certificate is not pin-suitable. Live files left untouched.");
  process.exit(1);
}
try {
  const servedCa = new X509Certificate(firstPemBlock(fs.readFileSync(caPath, "utf8"), "CERTIFICATE"));
  if (!renewed.verify(servedCa.publicKey)) {
    console.warn(`WARNING: ${caPath} does not contain the signing CA - clients may get an incomplete chain. Point TLS_CA_PATH at the CA used here.`);
  }
} catch {
  console.warn(`WARNING: could not parse ${caPath} to confirm it carries the signing CA.`);
}

if (fs.existsSync(certPath)) {
  fs.copyFileSync(certPath, `${certPath}.lan-backup`);
}
if (fs.existsSync(keyPath)) {
  fs.copyFileSync(keyPath, `${keyPath}.lan-backup`);
}
fs.mkdirSync(path.dirname(certPath), { recursive: true });
fs.mkdirSync(path.dirname(keyPath), { recursive: true });
fs.writeFileSync(certPath, certPemOut);
if (fs.existsSync(keyPath)) {
  fs.unlinkSync(keyPath);
}
fs.writeFileSync(keyPath, keyPemOut, { mode: 0o600 });
if (process.platform !== "win32") {
  try {
    fs.chmodSync(keyPath, 0o600);
  } catch {
    // Ignore chmod errors on platforms that don't support it
  }
}

console.log(`Renewed LAN certificate (valid ${validityDays} days) at ${certPath}`);
console.log(`Valid: ${status.validFrom} -> ${status.validTo}`);
console.log(`Covers: ${hostnames.join(", ")}`);
console.log(`Certificate SHA-256: ${computeCertificateHash(certPemOut)}`);
console.log("Restart the server to pick it up. Schedule this every 10 days so the 13-day certificate never lapses.");
