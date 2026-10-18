import crypto from "crypto";
import log from "../modules/logger";

export let _privateKey: string | null = null;

export function decryptPrivateKey(encryptedKey: string, passphrase: string) {
  return crypto
    .createPrivateKey({
      key: encryptedKey,
      format: "pem",
      passphrase: passphrase,
    })
    .export({ type: "pkcs1", format: "pem" });
}

export function decryptRsa(
  encryptedMessage: Buffer,
  privateKeyPem: string
): string | null {
  try {

    if (!(encryptedMessage instanceof Buffer)) {
      encryptedMessage = Buffer.from(encryptedMessage);
    }

    const decrypted = crypto.privateDecrypt(
      {
        key: privateKeyPem,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: "sha256",
      },
      encryptedMessage as any
    );

    return decrypted.toString("utf8");
  } catch (error) {
    // Any client can send garbage to decrypt: said once a minute at most, with how many failed.
    failedDecryptions++;
    const now = Date.now();
    if (now - lastFailureLog >= 60_000) {
      log.warn(`Chat decryption failed (${failedDecryptions} in the last minute or so): ${error}`);
      lastFailureLog = now;
      failedDecryptions = 0;
    }
    return null;
  }
}

let failedDecryptions = 0;
let lastFailureLog = -Infinity;

export function generateKeyPair(passphrase: string | undefined): any {
  if (!passphrase) {
    log.error("No passphrase provided");
    return;
  }
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 4096,
    publicKeyEncoding: {
      type: "spki",
      format: "pem",
    },
    privateKeyEncoding: {
      type: "pkcs8",
      format: "pem",
      cipher: "aes-256-cbc",
      passphrase: passphrase,
    },
  });

  _privateKey = privateKey;

  return {
    publicKey,
    privateKey,
  };
}
