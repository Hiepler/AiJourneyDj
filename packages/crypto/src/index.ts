import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export class CredentialCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialCryptoError";
  }
}

function deriveKey(secret: string): Buffer {
  if (secret.trim().length < 16) {
    throw new CredentialCryptoError("APP_SECRET must be at least 16 characters.");
  }

  return createHash("sha256").update(secret).digest();
}

export function encryptJson(value: unknown, secret: string): string {
  const key = deriveKey(secret);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [
    "v1",
    iv.toString("base64url"),
    authTag.toString("base64url"),
    ciphertext.toString("base64url")
  ].join(".");
}

export function decryptJson<T>(payload: string, secret: string): T {
  try {
    const [version, ivRaw, authTagRaw, ciphertextRaw] = payload.split(".");
    if (version !== "v1" || !ivRaw || !authTagRaw || !ciphertextRaw) {
      throw new CredentialCryptoError("Unsupported encrypted payload format.");
    }

    const decipher = createDecipheriv("aes-256-gcm", deriveKey(secret), Buffer.from(ivRaw, "base64url"));
    decipher.setAuthTag(Buffer.from(authTagRaw, "base64url"));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(ciphertextRaw, "base64url")),
      decipher.final()
    ]);

    return JSON.parse(decrypted.toString("utf8")) as T;
  } catch (error) {
    if (error instanceof CredentialCryptoError) {
      throw error;
    }
    throw new CredentialCryptoError("Unable to decrypt stored credentials.");
  }
}
