const DEFAULT_SITE_URL = "https://growthaudit.growsparkconsulting.com";

export function getSiteUrl(): string {
  let siteUrl = process.env.NEXT_PUBLIC_SITE_URL?.trim() || DEFAULT_SITE_URL;
  while (siteUrl.endsWith("/")) siteUrl = siteUrl.slice(0, -1);
  return siteUrl;
}

export const SITE_URL = getSiteUrl();

export const SITE_NAME = "Grow Spark Consulting";
export const LANDING_TITLE = "Business Growth Audit | Grow Spark Consulting";
export const LANDING_DESCRIPTION =
  "Find the constraints holding your business back with the Grow Spark Business Growth Audit.";

export const FREE_SITE_URL = (
  process.env.NEXT_PUBLIC_FREE_SITE_URL ?? "https://growthaudit-free.growsparkconsulting.com"
).replace(/\/$/, "");

/** Whether search engines may index the free landing page (it is a public campaign page). */
export const FREE_PAGE_INDEXABLE = true;
