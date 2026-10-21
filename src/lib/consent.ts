/**
 * Marketing-cookie consent. Stored in a first-party cookie (not localStorage) so the
 * server can also see it and skip Conversions API events for visitors who declined.
 * Host-only: the paid and free sites each ask separately.
 */
export const CONSENT_COOKIE = "gs_consent";
export const CONSENT_MAX_AGE_SECONDS = 180 * 24 * 60 * 60;

export type ConsentState = "granted" | "denied";

/** Fired on window when the visitor makes or changes a choice. */
export const CONSENT_CHANGE_EVENT = "gs:consent-change";
/** Fired on window to reopen the consent banner (footer "Cookie preferences"). */
export const OPEN_CONSENT_EVENT = "gs:open-consent";

export function readCookie(cookieHeader: string | null | undefined, name: string): string | undefined {
  for (const part of (cookieHeader ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1 || part.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** null means the visitor has not chosen yet. */
export function parseConsent(cookieHeader: string | null | undefined): ConsentState | null {
  const value = readCookie(cookieHeader, CONSENT_COOKIE);
  return value === "granted" || value === "denied" ? value : null;
}

export function buildConsentCookie(state: ConsentState, secure: boolean): string {
  return `${CONSENT_COOKIE}=${state}; Path=/; Max-Age=${CONSENT_MAX_AGE_SECONDS}; SameSite=Lax${secure ? "; Secure" : ""}`;
}
