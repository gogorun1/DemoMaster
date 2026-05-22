import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 120;

const MAX_MEDIA_BYTES = 80 * 1024 * 1024;

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as { url?: string };
    const url = normalizeImportUrl(payload.url);
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) throw new Error(`Media URL returned ${response.status}.`);

    const length = Number(response.headers.get("content-length") || 0);
    if (length > MAX_MEDIA_BYTES) throw new Error("Media URL is too large for project import.");

    const mimeType = response.headers.get("content-type")?.split(";")[0]?.trim() || inferMimeType(url);
    const type = mediaTypeFromMime(mimeType);
    if (!type) throw new Error("Media URL must point to an image or video file.");

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > MAX_MEDIA_BYTES) throw new Error("Media URL is too large for project import.");

    return NextResponse.json({
      type,
      name: mediaNameFromUrl(url, mimeType),
      mimeType,
      dataUrl: `data:${mimeType};base64,${buffer.toString("base64")}`,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not import media URL." },
      { status: 400 },
    );
  }
}

function normalizeImportUrl(raw: unknown) {
  if (typeof raw !== "string" || !raw.trim()) throw new Error("Media URL is required.");
  const url = new URL(raw.trim());
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Media URL must start with http or https.");
  return url.toString();
}

function mediaTypeFromMime(mimeType: string) {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  return undefined;
}

function inferMimeType(url: string) {
  const pathname = new URL(url).pathname.toLowerCase();
  if (pathname.endsWith(".png")) return "image/png";
  if (pathname.endsWith(".jpg") || pathname.endsWith(".jpeg")) return "image/jpeg";
  if (pathname.endsWith(".webp")) return "image/webp";
  if (pathname.endsWith(".gif")) return "image/gif";
  if (pathname.endsWith(".mp4")) return "video/mp4";
  if (pathname.endsWith(".webm")) return "video/webm";
  if (pathname.endsWith(".mov")) return "video/quicktime";
  return "application/octet-stream";
}

function mediaNameFromUrl(url: string, mimeType: string) {
  const pathname = new URL(url).pathname;
  const last = pathname.split("/").filter(Boolean).at(-1);
  if (last) return decodeURIComponent(last).slice(0, 80);
  return mimeType.startsWith("image/") ? "imported-image" : "imported-video";
}
