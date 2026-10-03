const textEncoder = new TextEncoder();

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, Math.min(index + chunkSize, bytes.length)));
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function base64UrlToBytes(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/u.test(value)) return null;
  try {
    const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (value.length % 4)) % 4);
    const binary = atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

/**
 * Compare secret material without an early return. The loop also covers the
 * longer input when lengths differ, so a caller cannot use a short-circuit
 * comparison as a token oracle.
 */
export function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  const maxLength = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < maxLength; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

export function constantTimeEqualString(left: string, right: string): boolean {
  return constantTimeEqual(textEncoder.encode(left), textEncoder.encode(right));
}

export interface SignedDownloadPayload {
  objectKey: string;
  filename: string;
  mimeType: string;
  exp: number;
}

function jsonBase64Url(value: unknown): string {
  return bytesToBase64Url(textEncoder.encode(JSON.stringify(value)));
}

async function hmac(secret: string, payload: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, textEncoder.encode(payload)));
}

export async function createDownloadToken(secret: string, payload: SignedDownloadPayload): Promise<string> {
  if (!secret) throw new Error("missing download-link signing secret");
  const encodedPayload = jsonBase64Url(payload);
  const signature = bytesToBase64Url(await hmac(secret, encodedPayload));
  return `${encodedPayload}.${signature}`;
}

export async function verifyDownloadToken(secret: string, token: string, nowSeconds = Math.floor(Date.now() / 1000)): Promise<SignedDownloadPayload | null> {
  if (!secret) return null;
  const parts = token.split(".");
  if (parts.length !== 2 || parts.some((part) => part.length === 0)) return null;
  const [encodedPayload, encodedSignature] = parts;
  if (!encodedPayload || !encodedSignature) return null;
  const providedSignature = base64UrlToBytes(encodedSignature);
  if (!providedSignature) return null;
  const expectedSignature = await hmac(secret, encodedPayload);
  if (!constantTimeEqual(expectedSignature, providedSignature)) return null;

  const encoded = base64UrlToBytes(encodedPayload);
  if (!encoded) return null;
  try {
    const raw = JSON.parse(new TextDecoder().decode(encoded)) as Partial<SignedDownloadPayload> & { k?: unknown; n?: unknown; e?: unknown };
    // Accept the compact token emitted by the Python Container's S3/R2
    // uploader as well as this Worker's self-describing form. Both forms are
    // authenticated over their original encoded payload.
    const payload: Partial<SignedDownloadPayload> = {
      objectKey: typeof raw.objectKey === "string" ? raw.objectKey : typeof raw.k === "string" ? raw.k : undefined,
      filename: typeof raw.filename === "string" ? raw.filename : typeof raw.n === "string" ? raw.n : undefined,
      mimeType: typeof raw.mimeType === "string" ? raw.mimeType : "application/octet-stream",
      exp: typeof raw.exp === "number" ? raw.exp : typeof raw.e === "number" ? raw.e : undefined,
    };
    if (
      typeof payload.objectKey !== "string" ||
      !/^jobs\/[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}\/[A-Za-z0-9_()\x5b\x5d{}+@=,-][A-Za-z0-9 ._()\x5b\x5d{}+@=,-]{0,179}$/u.test(payload.objectKey) ||
      typeof payload.filename !== "string" ||
      typeof payload.mimeType !== "string" ||
      typeof payload.exp !== "number" ||
      !Number.isSafeInteger(payload.exp) ||
      payload.exp <= nowSeconds
    ) {
      return null;
    }
    return payload as SignedDownloadPayload;
  } catch {
    return null;
  }
}

export function sanitizeFilename(filename: string, fallback = "media.bin"): string {
  const normalized = [...filename.normalize("NFKC")].filter((character) => {
    const code = character.charCodeAt(0);
    return code >= 0x20 && code !== 0x7f;
  }).join("");
  const basename = normalized.replaceAll("\\", "/").split("/").pop()?.trim() ?? "";
  const safe = basename.replace(/[^A-Za-z0-9 ._()\x5b\x5d{}+@=,-]/gu, "_").replace(/\s+/gu, " ").trim();
  return safe.slice(0, 180).replace(/[ .]+$/u, "") || fallback;
}

export function safeContentDisposition(filename: string): string {
  const safe = sanitizeFilename(filename);
  const ascii = safe.replace(/[^\x20-\x7e]/gu, "_").replaceAll('"', "'");
  return `attachment; filename="${ascii}"`;
}
