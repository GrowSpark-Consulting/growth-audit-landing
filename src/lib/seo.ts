import { FREE_HOST, normalizeHost } from "@/lib/host-routing";
import { FREE_SITE_URL, SITE_URL } from "@/lib/site";

/**
 * Per-host robots.txt and sitemap.xml content. One deployment serves both landing pages,
 * so each host advertises only its own URL. Pure so it can be unit-tested.
 */
export function siteUrlForHost(hostHeader: string | null | undefined): string {
  return normalizeHost(hostHeader) === FREE_HOST ? FREE_SITE_URL : SITE_URL;
}

/** Thank-you pages are noindex and the API is not content, so crawlers skip both. */
export const DISALLOWED_PATHS = ["/api/", "/thank-you", "/growth-audit/thank-you"];
