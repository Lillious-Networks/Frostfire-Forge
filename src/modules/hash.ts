import crypto from "crypto";

export async function hash(password: string) {
  return await Bun.password.hash(password);
}

export async function verify(password: string, hash: string) {
  return await Bun.password.verify(password, hash);
}

export function getHash(password: string) {
  const hash = crypto.createHash("sha512").update(password).digest("hex");
  const numberValue = Object.assign([], Array.from(hash.replace(/[a-z]/g, "")));
  const sum = numberValue.reduce(
    (acc: number, _curr: string, i: number) => acc + i,
    0
  );
  return [hash, numberValue, sum];
}

export function createSecureToken() {
  const token = randomBytes(32);
  return {hash: hash(token), value: token};
}

export function verifySecureToken(token: string, hash: string) {
  return Bun.password.verify(token, hash);
}

export function randomBytes(size: number) {
  return crypto.randomBytes(size).toString("hex");
}