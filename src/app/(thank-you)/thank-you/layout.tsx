import type { Metadata, Viewport } from "next";
import { MetaTracking } from "@/components/tracking/MetaTracking";
import { SITE_NAME, SITE_URL } from "@/lib/site";
import "./thank-you.css";

const TITLE = `Thank You | ${SITE_NAME}`;

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: TITLE,
  alternates: { canonical: "/thank-you" },
  // Post-purchase page: keep it out of search results.
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: "#101719",
  colorScheme: "light",
};

export default function ThankYouLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
        {/* Consent banner only; the verified Purchase event is rendered by the page itself. */}
        <MetaTracking funnel="paid" />
      </body>
    </html>
  );
}
