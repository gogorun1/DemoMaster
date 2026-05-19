import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export const runtime = "nodejs";

const contentTypes: Record<string, string> = {
  ".png": "image/png",
  ".webm": "video/webm",
};

export async function GET(_: Request, context: { params: Promise<{ path: string[] }> }) {
  const params = await context.params;
  const segments = params.path || [];
  if (segments.length !== 2 || segments.some((segment) => !/^[a-zA-Z0-9._-]+$/.test(segment))) {
    return new Response("Not found", { status: 404 });
  }

  const root = path.join(tmpdir(), "demomaster-captures");
  const filePath = path.join(root, ...segments);
  if (!filePath.startsWith(root)) return new Response("Not found", { status: 404 });

  try {
    const file = await readFile(filePath);
    return new Response(file, {
      headers: {
        "Cache-Control": "public, max-age=3600",
        "Content-Type": contentTypes[path.extname(filePath).toLowerCase()] || "application/octet-stream",
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
