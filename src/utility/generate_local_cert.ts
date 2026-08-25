#!/usr/bin/env bun

import { ensureLocalCertificate } from "./local_cert.ts";

const certPath = process.env.TLS_CERT_PATH;
const keyPath = process.env.TLS_KEY_PATH;
const caPath = process.env.TLS_CA_PATH;

if (!certPath || !keyPath) {
  console.error("TLS_CERT_PATH and TLS_KEY_PATH must be set to generate a local WebTransport certificate.");
  process.exit(1);
}

const generated = await ensureLocalCertificate({ certPath, keyPath, caPath });

if (generated) {
  console.log(`Certificate SHA-256: ${generated.hash}`);
  console.log(`Saved to ${certPath} and ${keyPath}`);
} else {
  console.log("Local WebTransport certificate is already valid. No changes made.");
}
