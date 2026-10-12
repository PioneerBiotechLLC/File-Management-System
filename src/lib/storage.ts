import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  NoSuchKey,
  NotFound,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { storageEnv } from "@/lib/env";

/**
 * File bytes live in a private S3-compatible bucket (Cloudflare R2 by default).
 * Browsers upload and download directly with short-lived presigned URLs, so bytes
 * never pass through a Vercel function.
 *
 * An upload goes to a staging key; confirming copies it to the final key. The upload URL stays
 * valid for a while after that, so anything PUT to it later lands in the staging key, which is
 * swept, never in the file people download or the AI reads.
 */

export const UPLOAD_URL_SECONDS = 15 * 60;
const DOWNLOAD_URL_SECONDS = 5 * 60;

let client: { s3: S3Client; bucket: string } | null = null;

function bucket() {
  if (!client) {
    const env = storageEnv();
    client = {
      bucket: env.FILES_S3_BUCKET,
      s3: new S3Client({
        endpoint: env.FILES_S3_ENDPOINT,
        region: env.FILES_S3_REGION,
        forcePathStyle: true,
        credentials: {
          accessKeyId: env.FILES_S3_ACCESS_KEY_ID,
          secretAccessKey: env.FILES_S3_SECRET_ACCESS_KEY,
        },
        // Without these the SDK adds CRC32 checksum parameters to presigned PUTs, which
        // browsers cannot satisfy and R2 rejects.
        requestChecksumCalculation: "WHEN_REQUIRED",
        responseChecksumValidation: "WHEN_REQUIRED",
      }),
    };
  }
  return client;
}

const ID = /^[A-Za-z0-9_-]+$/;

/** `<orgId>/<fileId>/<versionNo>`: never the file name, which is user-controlled. */
export function objectKey(orgId: string, fileId: string, versionNo: number): string {
  if (!ID.test(orgId) || !ID.test(fileId)) throw new Error("Invalid id in object key");
  if (!Number.isInteger(versionNo) || versionNo < 1) throw new Error("Invalid version number");
  return `${orgId}/${fileId}/${versionNo}`;
}

/** Where the browser uploads a version to, before it is confirmed and copied to its object key. */
export function uploadKey(orgId: string, fileId: string, versionNo: number): string {
  return `${objectKey(orgId, fileId, versionNo)}.upload`;
}

/** RFC 5987 encoding, so Arabic and other non-ASCII names survive the download. */
export function contentDisposition(kind: "attachment" | "inline", fileName: string): string {
  const encoded = encodeURIComponent(fileName).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${kind}; filename*=UTF-8''${encoded}`;
}

export async function presignUpload(key: string, contentType: string): Promise<string> {
  const { s3, bucket: Bucket } = bucket();
  return getSignedUrl(s3, new PutObjectCommand({ Bucket, Key: key, ContentType: contentType }), {
    expiresIn: UPLOAD_URL_SECONDS,
  });
}

export async function presignDownload(
  key: string,
  fileName: string,
  options: { inline?: boolean; contentType?: string } = {},
): Promise<string> {
  const { s3, bucket: Bucket } = bucket();
  const command = new GetObjectCommand({
    Bucket,
    Key: key,
    ResponseContentDisposition: contentDisposition(options.inline ? "inline" : "attachment", fileName),
    ResponseContentType: options.contentType,
  });
  return getSignedUrl(s3, command, { expiresIn: DOWNLOAD_URL_SECONDS });
}

/** Size and type of a stored object, or null when it does not exist. */
export async function head(key: string): Promise<{ sizeBytes: number; contentType: string | null } | null> {
  const { s3, bucket: Bucket } = bucket();
  try {
    const out = await s3.send(new HeadObjectCommand({ Bucket, Key: key }));
    return { sizeBytes: out.ContentLength ?? 0, contentType: out.ContentType ?? null };
  } catch (error) {
    if (error instanceof NotFound) return null;
    throw error;
  }
}

/** Copies an object within the bucket, setting the type the file was declared with. */
export async function copy(fromKey: string, toKey: string, contentType: string): Promise<void> {
  const { s3, bucket: Bucket } = bucket();
  await s3.send(
    new CopyObjectCommand({
      Bucket,
      Key: toKey,
      CopySource: `${Bucket}/${fromKey}`,
      MetadataDirective: "REPLACE",
      ContentType: contentType,
    }),
  );
}

/** The bytes of a stored object, or null when it does not exist. Used only to read a file with the AI. */
export async function getObject(key: string): Promise<Uint8Array | null> {
  const { s3, bucket: Bucket } = bucket();
  try {
    const out = await s3.send(new GetObjectCommand({ Bucket, Key: key }));
    return out.Body ? await out.Body.transformToByteArray() : null;
  } catch (error) {
    if (error instanceof NoSuchKey || error instanceof NotFound) return null;
    throw error;
  }
}

export async function remove(key: string): Promise<void> {
  const { s3, bucket: Bucket } = bucket();
  await s3.send(new DeleteObjectCommand({ Bucket, Key: key }));
}

/** Confirms the bucket exists and the credentials can reach it. */
export async function checkBucket(): Promise<void> {
  const { s3, bucket: Bucket } = bucket();
  await s3.send(new HeadBucketCommand({ Bucket }));
}
