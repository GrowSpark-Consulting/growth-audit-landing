import type { MetadataRoute } from "next";
import { headers } from "next/headers";
import { siteUrlForHost } from "@/lib/seo";

// Reading the host makes this request-time, so each domain gets its own sitemap.
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const requestHeaders = await headers();
  const siteUrl = siteUrlForHost(requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host"));

  return [{ url: `${siteUrl}/`, changeFrequency: "weekly", priority: 1 }];
}
