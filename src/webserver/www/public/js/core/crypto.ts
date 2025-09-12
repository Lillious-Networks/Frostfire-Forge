export default async function encryptRsa(chatDecryptionKey: string, data: string) {
  const cleanedKey = cleanBase64Key(chatDecryptionKey);
  const importedKey = await window.crypto.subtle.importKey(
    "spki",
    new Uint8Array(atob(cleanedKey).split('').map(c => c.charCodeAt(0))),
    {
      name: "RSA-OAEP",
      hash: "SHA-256"
    },
    false,
    ["encrypt"]
  );

  const encoded = new TextEncoder().encode(data);
  const encrypted = await window.crypto.subtle.encrypt(
    { name: "RSA-OAEP" },
    importedKey,
    encoded
  );

  return new Uint8Array(encrypted);
}

function cleanBase64Key(base64Key: string): string {
  return base64Key.replace(/-----BEGIN PUBLIC KEY-----|-----END PUBLIC KEY-----|\s+/g, '');
}