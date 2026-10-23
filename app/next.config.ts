import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The dashboard reads ../logs at request time; never cache pages.
  poweredByHeader: false,
};

export default nextConfig;
