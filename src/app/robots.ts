import type { MetadataRoute } from "next";
import { headers } from "next/headers";
import { DISALLOWED_PATHS, siteUrlForHost } from "@/lib/seo";

// Reading the host makes this request-time, so each domain points at its own sitemap.
export default async function robots(): Promise<MetadataRoute.Robots> {
  const requestHeaders = await headers();
  const siteUrl = siteUrlForHost(requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host"));

  return {
    rules: { userAgent: "*", allow: "/", disallow: DISALLOWED_PATHS },
    sitemap: `${siteUrl}/sitemap.xml`,
    host: siteUrl,
  };
}
