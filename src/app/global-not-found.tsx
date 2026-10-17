import type { Metadata } from "next";
import Link from "next/link";
import "./not-found.css";

export const metadata: Metadata = {
  title: "Page not found | Grow Spark Consulting",
  robots: { index: false },
};

export default function GlobalNotFound() {
  return (
    <html lang="en">
      <body>
        <main>
          <p className="code">404</p>
          <h1>This page could not be found.</h1>
          <Link href="/">Back to the Business Growth Audit</Link>
        </main>
      </body>
    </html>
  );
}
