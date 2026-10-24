import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // No Next.js dev badge in screen recordings.
  devIndicators: false,
  // A production build gets its own folder so it can run next to `npm run dashboard` (dev).
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // The dashboard is its own app inside the repo; don't let Next guess the root.
  outputFileTracingRoot: process.cwd(),
};

export default nextConfig;
