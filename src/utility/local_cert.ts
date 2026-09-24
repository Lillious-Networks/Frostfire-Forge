import { webcrypto as crypto, X509Certificate, createHash } from "crypto";
import fs from "node:fs";
import path from "node:path";
import log from "../modules/logger.ts";

const ECDSA_SHA256_OID = "1.2.840.10045.4.3.2";
const MAX_VALIDITY_DAYS = 14;

export interface LocalCertificateOptions {
  certPath: string;
  keyPath: string;
  caPath?: string;
  validityDays?: number;
  hostnames?: string[];
  /**
   * Replace the existing files even when they look usable. Needed to recover
   * from an expired CA-signed certificate, which is otherwise never touched
   * (see certificateNeedsRegeneration) and would be reported as valid.
   */
  force?: boolean;
}

export interface CertificateStatus {
  /** The PEM parsed as X.509 at all. */
  parseable: boolean;
  /** The certificate is its own issuer. Only these are auto-regenerated. */
  selfSigned: boolean;
  /** Short-lived EC cert with localhost/127.0.0.1 SANs: pinnable via /wt-cert-hash. */
  supportsPinning: boolean;
  /** Whether ensureLocalCertificate would replace this certificate. */
  needsRegeneration: boolean;
  /** Outside its validity window right now. */
  expired: boolean;
  /** Whole days until expiry (negative when expired, null when unparseable). */
  daysRemaining: number | null;
  validFrom: string | null;
  validTo: string | null;
}

/**
 * Truthful one-shot summary of a certificate file. Unlike
 * certificateNeedsRegeneration this reports expiry for CA-signed
 * certificates too, so callers can tell "expired, renew via your CA" apart
 * from "valid".
 */
export function getCertificateStatus(certPem: string): CertificateStatus {
  const unusable: CertificateStatus = {
    parseable: false,
    selfSigned: false,
    supportsPinning: false,
    needsRegeneration: true,
    expired: true,
    daysRemaining: null,
    validFrom: null,
    validTo: null,
  };

  let cert: X509Certificate;
  try {
    cert = new X509Certificate(certPem);
  } catch {
    return unusable;
  }

  const validFromMs = Date.parse(cert.validFrom);
  const validToMs = Date.parse(cert.validTo);
  if (!Number.isFinite(validFromMs) || !Number.isFinite(validToMs)) {
    return unusable;
  }

  const now = Date.now();
  const expired = now < validFromMs || now > validToMs;
  const daysRemaining = Math.floor((validToMs - now) / 86400000);

  let selfSigned = false;
  try {
    selfSigned = cert.verify(cert.publicKey);
  } catch {
    return {
      ...unusable,
      parseable: true,
      validFrom: cert.validFrom,
      validTo: cert.validTo,
      daysRemaining,
      expired,
    };
  }

  const validityDays = (validToMs - validFromMs) / 86400000;
  const san = cert.subjectAltName || "";
  const supportsPinning =
    !expired &&
    validityDays <= MAX_VALIDITY_DAYS &&
    (cert.publicKey as any).asymmetricKeyType === "ec" &&
    san.includes("localhost") &&
    san.includes("127.0.0.1");

  return {
    parseable: true,
    selfSigned,
    supportsPinning,
    // Only self-signed certificates are ours to replace; a CA-signed one
    // that omits a name or has expired is the operator's to reissue.
    needsRegeneration: selfSigned ? !supportsPinning : false,
    expired,
    daysRemaining,
    validFrom: cert.validFrom,
    validTo: cert.validTo,
  };
}

export interface GeneratedCertificate {
  certPem: string;
  keyPem: string;
  hash: string;
}

type Forge = typeof import("node-forge");

export async function loadForge(): Promise<Forge> {
  try {
    const module = await import("node-forge");
    return (module.default ?? module) as Forge;
  } catch {
    throw new Error(
      "node-forge is not installed. It is a development-only dependency required for local certificate generation. Run `bun generate-local-cert` on a machine with dev dependencies installed."
    );
  }
}

function dnToAsn1(forge: Forge, attributes: any[]): any {
  const { asn1 } = forge;
  return asn1.create(
    asn1.Class.UNIVERSAL,
    asn1.Type.SEQUENCE,
    true,
    attributes.map((attr) =>
      asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SET, true, [
        asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
          asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OID, false, asn1.oidToDer(attr.type).getBytes()),
          asn1.create(asn1.Class.UNIVERSAL, attr.valueTagClass || asn1.Type.PRINTABLESTRING, false, attr.value),
        ]),
      ])
    )
  );
}

function dateToAsn1(forge: Forge, date: Date): any {
  const { asn1 } = forge;
  const pad = (n: number) => String(n).padStart(2, "0");
  const utc = `${pad(date.getUTCFullYear() % 100)}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
  const year = date.getUTCFullYear();
  if (year >= 1950 && year < 2050) {
    return asn1.create(asn1.Class.UNIVERSAL, asn1.Type.UTCTIME, false, utc);
  }
  const generalized = `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
  return asn1.create(asn1.Class.UNIVERSAL, asn1.Type.GENERALIZEDTIME, false, generalized);
}

export const SHA256_WITH_RSA_OID = "1.2.840.113549.1.1.11";

export function buildTbsCertificate(
  forge: Forge,
  cert: any,
  publicKeySpki: ArrayBuffer,
  signatureOid: string = ECDSA_SHA256_OID,
  // RFC 5758 section 3.2: ecdsa-with-SHA256 parameters MUST be absent.
  // Including the NULL parameter causes strict TLS stacks (rustls/wtransport
  // trust-anchor verification) to reject the certificate. RSA signatures
  // (sha256WithRSAEncryption) require the NULL parameter instead.
  includeSignatureNullParams = false
): any {
  const { asn1, pki, util } = forge;
  const sigAlgValue: any[] = [
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OID, false, asn1.oidToDer(signatureOid).getBytes()),
  ];
  if (includeSignatureNullParams) {
    sigAlgValue.push(asn1.create(asn1.Class.UNIVERSAL, asn1.Type.NULL, false, ""));
  }
  return asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
    asn1.create(asn1.Class.CONTEXT_SPECIFIC, 0, true, [
      asn1.create(asn1.Class.UNIVERSAL, asn1.Type.INTEGER, false, asn1.integerToDer(2).getBytes()),
    ]),
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.INTEGER, false, util.hexToBytes(cert.serialNumber)),
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, sigAlgValue),
    dnToAsn1(forge, cert.issuer.attributes),
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
      dateToAsn1(forge, cert.validity.notBefore),
      dateToAsn1(forge, cert.validity.notAfter),
    ]),
    dnToAsn1(forge, cert.subject.attributes),
    asn1.fromDer(new (util as any).ByteBuffer(publicKeySpki)),
    (pki as any).certificateExtensionsToAsn1(cert.extensions),
  ]);
}

export function positiveSerialHex(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(9));
  let hex = Buffer.from(bytes).toString("hex").replace(/^0+/, "") || "1";
  const firstDigit = parseInt(hex[0], 16);
  if (firstDigit >= 8) {
    hex = (firstDigit - 8).toString(16) + hex.slice(1);
  }
  return hex;
}

function rawEcdsaSignatureToDer(raw: Uint8Array): Buffer {
  const r = Buffer.from(raw.slice(0, 32));
  const s = Buffer.from(raw.slice(32, 64));

  const encodeInteger = (value: Buffer): Buffer => {
    let start = 0;
    while (start < value.length - 1 && value[start] === 0) {
      start++;
    }
    const trimmed = value.subarray(start);
    if (trimmed[0] & 0x80) {
      return Buffer.concat([Buffer.from([0x00]), trimmed]);
    }
    return Buffer.from(trimmed);
  };

  const rDer = encodeInteger(r);
  const sDer = encodeInteger(s);

  const body = Buffer.concat([
    Buffer.from([0x02, rDer.length]),
    rDer,
    Buffer.from([0x02, sDer.length]),
    sDer,
  ]);

  const lengthBytes = body.length < 128 ? [body.length] : [0x81, body.length];
  return Buffer.concat([Buffer.from([0x30, ...lengthBytes]), body]);
}

export async function generateLocalCertificate(options: {
  validityDays?: number;
  hostnames?: string[];
} = {}): Promise<GeneratedCertificate> {
  const forge = await loadForge();
  const { asn1, oids, pki, util } = forge as any;

  (oids as any)["1.2.840.10045.4.3.2"] = "ecdsa-with-SHA256";
  (oids as any)["ecdsa-with-SHA256"] = "1.2.840.10045.4.3.2";

  const validityDays = options.validityDays ?? MAX_VALIDITY_DAYS - 1;
  const hostnames = options.hostnames ?? ["localhost", "127.0.0.1", "::1"];

  if (validityDays < 1 || validityDays >= MAX_VALIDITY_DAYS) {
    throw new Error(`validityDays must be between 1 and ${MAX_VALIDITY_DAYS - 1} for WebTransport certificate pinning`);
  }

  const keyPair = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"]
  )) as CryptoKeyPair;

  const cert = pki.createCertificate();
  cert.serialNumber = positiveSerialHex();
  cert.validity.notBefore = new Date(Date.now() - 86400000);
  cert.validity.notAfter = new Date(Date.now() + validityDays * 86400000);

  const subject = [{ shortName: "CN", value: "localhost" }];
  cert.setSubject(subject);
  cert.setIssuer(subject);

  const publicKeySpki = await crypto.subtle.exportKey("spki", keyPair.publicKey);
  (cert as any).publicKey = publicKeySpki;

  cert.setExtensions([
    { name: "basicConstraints", cA: false },
    { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
    {
      name: "subjectAltName",
      altNames: hostnames.map((host) => {
        const isIpv4 = /^(\d{1,3}\.){3}\d{1,3}$/.test(host);
        const isIpv6 = host.includes(":");
        return isIpv4 || isIpv6
          ? { type: 7, ip: host }
          : { type: 2, value: host };
      }),
    },
    { name: "extKeyUsage", serverAuth: true },
  ]);

  cert.siginfo.algorithmOid = ECDSA_SHA256_OID;
  (cert as any).signatureOid = ECDSA_SHA256_OID;

  const tbsCertificate = buildTbsCertificate(forge, cert, publicKeySpki);
  const tbsDer = Buffer.from(asn1.toDer(tbsCertificate).getBytes(), "binary");

  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    keyPair.privateKey,
    tbsDer
  );

  (cert as any).tbsCertificate = tbsCertificate;
  (cert as any).signature = rawEcdsaSignatureToDer(new Uint8Array(signature)).toString("binary");

  // Build the outer certificate manually instead of pki.certificateToPem:
  // forge appends a NULL parameter to the signatureAlgorithm for non-PSS
  // algorithms, which strict TLS stacks reject (RFC 5758 requires absent
  // parameters for ecdsa-with-SHA256).
  const certificateAsn1 = asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
    tbsCertificate,
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
      asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OID, false, asn1.oidToDer(ECDSA_SHA256_OID).getBytes()),
    ]),
    asn1.create(
      asn1.Class.UNIVERSAL,
      asn1.Type.BITSTRING,
      false,
      String.fromCharCode(0x00) + (cert as any).signature
    ),
  ]);

  const certPem = forge.pem.encode({
    type: "CERTIFICATE",
    body: asn1.toDer(certificateAsn1).getBytes(),
  });
  const privateKeyPem = forge.pem.encode({
    type: "PRIVATE KEY",
    body: new (util as any).ByteBuffer(await crypto.subtle.exportKey("pkcs8", keyPair.privateKey)).getBytes(),
  });

  return {
    certPem,
    keyPem: privateKeyPem,
    hash: computeCertificateHash(certPem),
  };
}

export function computeCertificateHash(certPem: string): string {
  const cert = new X509Certificate(certPem);
  return createHash("sha256").update(cert.raw).digest("base64");
}

export function certificateSupportsPinning(certPem: string): boolean {
  // Being self-signed is deliberately not required. serverCertificateHashes
  // constrains the key and the validity period, not the issuer, so a
  // short-lived certificate signed by a local CA is pinnable by Chromium
  // *and* validates normally in Safari, which does not implement pinning at
  // all and refuses a self-signed leaf. One certificate then serves both.
  return getCertificateStatus(certPem).supportsPinning;
}

/**
 * Whether `certPem` covers every name in `hostnames`.
 *
 * Regeneration otherwise keys only off expiry and pinning suitability, so
 * adding a hostname (a LAN address, say) leaves the old certificate in place
 * and the new name silently fails to validate. The comparison is textual
 * against the SAN because that is the form Node exposes.
 */
/** Whether the certificate is its own issuer. */
export function isSelfSigned(certPem: string): boolean {
  try {
    const cert = new X509Certificate(certPem);
    return cert.verify(cert.publicKey);
  } catch {
    return false;
  }
}

export function certificateCoversHostnames(certPem: string, hostnames: string[]): boolean {
  try {
    const san = new X509Certificate(certPem).subjectAltName || "";
    return hostnames.every((host) => san.includes(host));
  } catch {
    return false;
  }
}

export function certificateNeedsRegeneration(certPem: string): boolean {
  return getCertificateStatus(certPem).needsRegeneration;
}

async function certificateHasNullSignatureParams(certPem: string): Promise<boolean> {
  try {
    const forge = await loadForge();
    const decoded = forge.pem.decode(certPem);
    if (!decoded || decoded.length === 0 || !decoded[0]?.body) return true;
    const asn1Obj = forge.asn1.fromDer(decoded[0].body);
    const outerSigAlg = (asn1Obj as any)?.value?.[1];
    return !!(outerSigAlg && Array.isArray(outerSigAlg.value) && outerSigAlg.value.length > 1);
  } catch {
    return true;
  }
}

async function trustLocalCertificate(certPath: string): Promise<void> {
  if (process.env.SKIP_CERT_TRUST === "true") {
    return;
  }

  if (process.platform !== "win32") {
    log.warn("Automatic certificate trust is only supported on Windows. Import the generated certificate into your system trust store manually.");
    return;
  }

  try {
    const proc = Bun.spawn(["certutil", "-user", "-addstore", "Root", certPath], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const killTimer = setTimeout(() => {
      try {
        proc.kill();
      } catch (error: any) {
        log.debug(`Failed to terminate certutil: ${error?.message || error}`);
      }
    }, 10000);

    await proc.exited;
    clearTimeout(killTimer);

    if (proc.exitCode === 0) {
      log.success("Local WebTransport certificate added to the current user's trusted root store");
    } else {
      log.warn("certutil failed to trust the local certificate. Import it manually into Trusted Root Certification Authorities.");
    }
  } catch {
    log.warn("certutil is unavailable. Import the local certificate manually into Trusted Root Certification Authorities.");
  }
}

export async function ensureLocalCertificate(options: LocalCertificateOptions): Promise<GeneratedCertificate | null> {
  const certPath = options.certPath;
  const keyPath = options.keyPath;
  const caPath = options.caPath;

  const certExists = fs.existsSync(certPath);
  const keyExists = fs.existsSync(keyPath);

  let generated: GeneratedCertificate | null = null;
  if (certExists && keyExists && options.force) {
    log.warn("Forcing regeneration of the WebTransport certificate (--force)...");
    generated = await writeGeneratedCertificate(certPath, keyPath, caPath, options);
  } else if (certExists && keyExists) {
    const certPem = fs.readFileSync(certPath, "utf8");
    let needsRegen = certificateNeedsRegeneration(certPem);
    if (!needsRegen && options.hostnames?.length) {
      const cert = new X509Certificate(certPem);
      // Only self-signed certificates are ours to replace; a CA-signed one
      // that omits a name is the operator's to reissue.
      if (cert.verify(cert.publicKey) && !certificateCoversHostnames(certPem, options.hostnames)) {
        needsRegen = true;
      }
    }
    if (!needsRegen) {
      // Only self-signed certificates are candidates for regeneration;
      // production CA-signed certificates are never touched.
      const cert = new X509Certificate(certPem);
      if (cert.verify(cert.publicKey) && await certificateHasNullSignatureParams(certPem)) {
        needsRegen = true;
      }
    }
    if (needsRegen) {
      log.warn("Local WebTransport certificate is expired or unsuitable for pinning. Generating a new one...");
      generated = await writeGeneratedCertificate(certPath, keyPath, caPath, options);
    }
  } else {
    log.warn("No local WebTransport certificate found. Generating one...");
    generated = await writeGeneratedCertificate(certPath, keyPath, caPath, options);
  }

  if (!fs.existsSync(certPath)) {
    return generated;
  }

  const certPem = fs.readFileSync(certPath, "utf8");
  if (certificateSupportsPinning(certPem) && isSelfSigned(certPem)) {
    // A CA-signed certificate is skipped: it already chains to a trusted
    // root, and adding a leaf to the root store would be wrong.
    await trustLocalCertificate(certPath);
  }

  return generated;
}

async function writeGeneratedCertificate(
  certPath: string,
  keyPath: string,
  caPath: string | undefined,
  options: LocalCertificateOptions
): Promise<GeneratedCertificate | null> {
  let generated: GeneratedCertificate;
  try {
    generated = await generateLocalCertificate({
      validityDays: options.validityDays,
      hostnames: options.hostnames,
    });
  } catch (error: any) {
    log.error(`Local certificate generation failed: ${error?.message || error}`);
    throw error;
  }

  fs.mkdirSync(path.dirname(certPath), { recursive: true });
  fs.mkdirSync(path.dirname(keyPath), { recursive: true });
  fs.writeFileSync(certPath, generated.certPem);

  if (fs.existsSync(keyPath)) {
    fs.unlinkSync(keyPath);
  }
  fs.writeFileSync(keyPath, generated.keyPem, { mode: 0o600 });
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(keyPath, 0o600);
    } catch (e) {
      // Ignore chmod errors on platforms that don't support it
    }
  }

  if (caPath) {
    fs.mkdirSync(path.dirname(caPath), { recursive: true });
    fs.writeFileSync(caPath, "");
  }

  const cert = new X509Certificate(generated.certPem);
  const validityDays = Math.round((Date.parse(cert.validTo) - Date.parse(cert.validFrom)) / 86400000);

  log.success(`Generated local WebTransport certificate (valid ${validityDays} days) at ${certPath}`);

  return generated;
}
