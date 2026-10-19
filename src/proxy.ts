import { NextResponse, type NextRequest } from "next/server";
import { decideHostRouting } from "@/lib/host-routing";

export function proxy(request: NextRequest) {
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  const decision = decideHostRouting(host, request.nextUrl.pathname);

  if (decision.action === "rewrite") {
    const url = request.nextUrl.clone();
    url.pathname = decision.pathname;
    return NextResponse.rewrite(url);
  }
  if (decision.action === "redirect") {
    const url = request.nextUrl.clone();
    url.pathname = decision.pathname;
    return NextResponse.redirect(url, 308);
  }
  if (decision.action === "not-found") {
    // No route matches this path, so Next renders the global 404.
    const url = request.nextUrl.clone();
    url.pathname = "/__blocked_on_this_host";
    return NextResponse.rewrite(url, { status: 404 });
  }
  return NextResponse.next();
}

export const config = {
  // Only the routes whose behaviour depends on the hostname (see src/lib/host-routing.ts).
  matcher: ["/", "/free", "/thank-you", "/api/payment/:path*", "/api/orders/:path*", "/api/free-submit"],
};
