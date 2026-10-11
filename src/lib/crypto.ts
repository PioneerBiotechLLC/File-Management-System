import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { limitsEnv } from "@/lib/env";

/**
 * AES-256-GCM for extracted file text at rest. Stored as `enc:v1:<iv>:<tag>:<ciphertext>` (base64 parts).
 * Without DATA_ENCRYPTION_KEY, text is stored as is; reading still decrypts older encrypted rows
 * as long as the key is set.
 */

const PREFIX = "enc:v1:";

function configuredKey(): Buffer | null {
  const { DATA_ENCRYPTION_KEY } = limitsEnv();
  return DATA_ENCRYPTION_KEY ? Buffer.from(DATA_ENCRYPTION_KEY, "base64") : null;
}

export function sealText(plain: string, key: Buffer | null = configuredKey()): string {
  if (!key) return plain;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString("base64")}:${tag.toString("base64")}:${ciphertext.toString("base64")}`;
}

export function openText(stored: string, key: Buffer | null = configuredKey()): string {
  if (!stored.startsWith(PREFIX)) return stored;
  if (!key) throw new Error("This text is encrypted and DATA_ENCRYPTION_KEY is not set");
  const [iv, tag, ciphertext] = stored.slice(PREFIX.length).split(":");
  if (!iv || !tag || ciphertext === undefined) throw new Error("Malformed encrypted text");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64")), decipher.final()]).toString("utf8");
}
