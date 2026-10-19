/**
 * Hostname routing for the paid and free landing pages, which are served by one
 * deployment. Pure so it can be unit-tested; src/proxy.ts applies the decision.
 */
export const PAID_HOST = "growthaudit.growsparkconsulting.com";
export const FREE_HOST = "growthaudit-free.growsparkconsulting.com";

/** Routes that only exist for the paid (payment) workflow. */
const PAYMENT_PREFIXES = ["/api/payment", "/api/orders", "/thank-you"];
/** Routes that only exist for the free workflow. */
const FREE_PREFIXES = ["/free", "/api/free-submit"];

export type HostDecision =
  | { action: "next" }
  | { action: "rewrite"; pathname: string }
  | { action: "redirect"; pathname: string }
  | { action: "not-found" };

function matches(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export function normalizeHost(host: string | null | undefined): string {
  return (host ?? "").split(",")[0].trim().toLowerCase().replace(/:\d+$/, "");
}

export function decideHostRouting(hostHeader: string | null | undefined, pathname: string): HostDecision {
  const host = normalizeHost(hostHeader);

  if (host === FREE_HOST) {
    if (PAYMENT_PREFIXES.some((prefix) => matches(pathname, prefix))) return { action: "not-found" };
    if (pathname === "/") return { action: "rewrite", pathname: "/free" };
    if (matches(pathname, "/free")) return { action: "redirect", pathname: "/" };
    return { action: "next" };
  }

  // The paid production host must never serve the free page or its endpoint.
  // Other hosts (localhost, Vercel previews) can reach /free for testing.
  if (host === PAID_HOST && FREE_PREFIXES.some((prefix) => matches(pathname, prefix))) {
    return { action: "not-found" };
  }
  return { action: "next" };
}
