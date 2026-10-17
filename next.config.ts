import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Dev only: allow opening `next dev` from this machine's LAN address (phones, split-view tests).
  // Without it Next blocks client JS, so the countdown and sticky CTA never hydrate.
  allowedDevOrigins: ["172.20.176.1"],
  experimental: {
    // Lets us render a styled 404 even though each route group has its own root layout.
    globalNotFound: true,
  },
};

export default nextConfig;
