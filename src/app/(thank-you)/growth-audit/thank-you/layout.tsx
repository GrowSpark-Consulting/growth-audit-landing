import type { Metadata, Viewport } from "next";
import { GoogleTag } from "@/components/tracking/GoogleTag";
import { MetaTracking } from "@/components/tracking/MetaTracking";
import { FREE_SITE_URL, SITE_NAME } from "@/lib/site";
import "@/app/(thank-you)/thank-you/thank-you.css";

const TITLE = `Thank You | ${SITE_NAME}`;

export const metadata: Metadata = {
  metadataBase: new URL(FREE_SITE_URL),
  title: TITLE,
  alternates: { canonical: "/growth-audit/thank-you" },
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: "#101719",
  colorScheme: "light",
};

export default function GrowthAuditThankYouLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <GoogleTag />
      </head>
      <body>
        {children}
        <MetaTracking funnel="free" />
      </body>
    </html>
  );
}
