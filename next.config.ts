import type { NextConfig } from "next";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  reactStrictMode: true,
  allowedDevOrigins: ["127.0.0.1"],
  outputFileTracingIncludes: {
    "/api/capture": [
      "./node_modules/@vercel/sandbox/**/*",
      "./node_modules/@sparticuz/chromium/**/*",
      "./node_modules/playwright-core/**/*",
    ],
  },
  turbopack: {
    root: projectRoot,
  },
};

export default nextConfig;
