import type { Metadata, Viewport } from "next";
import { GoogleTag } from "@/components/tracking/GoogleTag";
import { MetaTracking } from "@/components/tracking/MetaTracking";
import { FREE_PAGE_INDEXABLE, FREE_SITE_URL, LANDING_DESCRIPTION, LANDING_TITLE, SITE_NAME } from "@/lib/site";
import "../../(landing)/landing.css";
import "./free.css";

// Canonical and Open Graph URLs resolve against the free host, never the paid one.
export const metadata: Metadata = {
  metadataBase: new URL(FREE_SITE_URL),
  title: LANDING_TITLE,
  description: LANDING_DESCRIPTION,
  alternates: { canonical: "/" },
  robots: FREE_PAGE_INDEXABLE ? undefined : { index: false, follow: false },
  openGraph: {
    type: "website",
    url: "/",
    siteName: SITE_NAME,
    title: LANDING_TITLE,
    description: LANDING_DESCRIPTION,
    images: [{ url: "/images/growspark-logo.png", width: 1920, height: 660 }],
  },
};

export const viewport: Viewport = {
  themeColor: "#101719",
};

export default function FreeLandingLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <GoogleTag />
      </head>
      <body>
        {children}
        <MetaTracking funnel="free" pageView />
      </body>
    </html>
  );
}
