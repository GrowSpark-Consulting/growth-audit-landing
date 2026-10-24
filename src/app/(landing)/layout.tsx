import type { Metadata, Viewport } from "next";
import { GoogleTag } from "@/components/tracking/GoogleTag";
import { MetaTracking } from "@/components/tracking/MetaTracking";
import { LANDING_DESCRIPTION, LANDING_TITLE, SITE_NAME, SITE_URL } from "@/lib/site";
import "./landing.css";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: LANDING_TITLE,
  description: LANDING_DESCRIPTION,
  alternates: { canonical: "/" },
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

export default function LandingLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <GoogleTag />
      </head>
      <body>
        {children}
        <MetaTracking funnel="paid" pageView />
      </body>
    </html>
  );
}
