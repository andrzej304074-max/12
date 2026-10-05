import { randomBytes } from "node:crypto";
import { put } from "@vercel/blob";
import { getConfig } from "../config.js";
import { ProInputError } from "./errors.js";

/**
 * Photos for listings.
 *
 * The Vinted Pro API takes no files: a listing names its photos by public,
 * permanent URL and Vinted fetches them itself. So a photo picked in the panel
 * has to live somewhere public first. When a Vercel Blob store is connected
 * (BLOB_READ_WRITE_TOKEN) the panel uploads there; without it the panel only
 * accepts addresses that already exist.
 *
 * The bytes are checked before they are stored: the format is read from the
 * file itself (not from what the browser claims), and only three image formats
 * under a size cap are accepted.
 */

export class PhotoUploadUnavailable extends Error {
  constructor() {
    super(
      "Photo upload is not set up. Create a Blob store in the Vercel project (Storage -> Create -> Blob), connect it to this project so BLOB_READ_WRITE_TOKEN is set, and redeploy. Until then paste the addresses of photos that are already online.",
    );
    this.name = "PhotoUploadUnavailable";
  }
}

/** Raw bytes; base64 of this still fits a 4.5 MB request. */
export const MAX_PHOTO_BYTES = 3_000_000;

const FORMATS = {
  jpeg: { type: "image/jpeg", ext: "jpg" },
  png: { type: "image/png", ext: "png" },
  webp: { type: "image/webp", ext: "webp" },
} as const;

/** Reads the format from the file's own first bytes. */
export function sniffImage(bytes: Uint8Array): (typeof FORMATS)[keyof typeof FORMATS] | null {
  const startsWith = (...sig: number[]) => sig.every((b, i) => bytes[i] === b);
  if (startsWith(0xff, 0xd8, 0xff)) return FORMATS.jpeg;
  if (startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return FORMATS.png;
  if (startsWith(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return FORMATS.webp;
  }
  return null;
}

/**
 * Where the bytes are stored. Vercel Blob in a deployment; the local demo
 * replaces it with an in-memory store so photos can be tried without an account.
 */
export const photoBackend = {
  put: (pathname: string, body: Buffer, options: { contentType: string; token: string }) =>
    put(pathname, body, { access: "public", addRandomSuffix: false, allowOverwrite: false, ...options }),
};

export interface UploadedPhoto {
  url: string;
  bytes: number;
  contentType: string;
}

export async function uploadPhoto(base64: string): Promise<UploadedPhoto> {
  const token = getConfig().blobToken;
  if (!token) throw new PhotoUploadUnavailable();

  const clean = base64.replace(/^data:[^,]*,/, "").trim();
  if (clean === "" || !/^[A-Za-z0-9+/]+={0,2}$/.test(clean) || clean.length % 4 === 1) {
    throw new ProInputError("The photo is not valid base64.");
  }
  const bytes = Buffer.from(clean, "base64");
  if (bytes.length === 0) throw new ProInputError("The photo is empty.");
  if (bytes.length > MAX_PHOTO_BYTES) {
    throw new ProInputError(`The photo is ${bytes.length} bytes; the limit is ${MAX_PHOTO_BYTES}. The panel shrinks photos before sending, so this one is unusually large.`);
  }
  const format = sniffImage(bytes);
  if (!format) throw new ProInputError("Only JPEG, PNG and WebP photos are accepted.");

  const month = new Date().toISOString().slice(0, 7);
  const pathname = `pro-photos/${month}/${randomBytes(12).toString("hex")}.${format.ext}`;
  const blob = await photoBackend.put(pathname, bytes, { contentType: format.type, token });
  // Vinted fetches the photo itself, so only a public https address is any use
  // (plain http is accepted outside production, for the local demo).
  const allowed = getConfig().isProduction ? /^https:\/\//i : /^https?:\/\//i;
  if (!allowed.test(blob.url)) {
    throw new ProInputError("The photo store returned an address that is not https.");
  }
  return { url: blob.url, bytes: bytes.length, contentType: format.type };
}
