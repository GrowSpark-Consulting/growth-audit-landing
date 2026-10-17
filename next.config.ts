
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,

  // Allow local network and ngrok origins during development.
  allowedDevOrigins: [
    "172.20.176.1",
    "reassure-among-employed.ngrok-free.dev",
  ],

  experimental: {
    // Lets us render a styled 404 with route groups using separate root layouts.
    globalNotFound: true,
  },
};

export default nextConfig;
