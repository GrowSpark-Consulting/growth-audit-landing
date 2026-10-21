"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { CONSENT_CHANGE_EVENT, OPEN_CONSENT_EVENT, parseConsent, type ConsentState } from "@/lib/consent";
import {
  browserPixelEnvironment,
  isValidPixelId,
  loadPixel,
  META_CONTENT_NAME,
  META_PIXEL_ID,
  setConsent,
  trackMetaEvent,
  type MetaFunnel,
} from "@/lib/meta-pixel";
import styles from "./tracking.module.css";

type ConsentSnapshot = ConsentState | "unset" | "server";

function subscribe(onChange: () => void) {
  window.addEventListener(CONSENT_CHANGE_EVENT, onChange);
  return () => window.removeEventListener(CONSENT_CHANGE_EVENT, onChange);
}

function useConsent(): ConsentSnapshot {
  return useSyncExternalStore(
    subscribe,
    () => parseConsent(document.cookie) ?? "unset",
    () => "server"
  );
}

const PIXEL_ENABLED = isValidPixelId(META_PIXEL_ID);
let pageViewTracked = false;

/**
 * Consent banner plus the Meta Pixel. The Pixel script loads only after "Accept"; until then
 * (or after "Decline") no Meta request is made. Renders nothing when no Pixel ID is configured.
 */
export function MetaTracking({ funnel, pageView = false }: { funnel: MetaFunnel; pageView?: boolean }) {
  const consent = useConsent();
  const [reopened, setReopened] = useState(false);

  useEffect(() => {
    const open = () => setReopened(true);
    window.addEventListener(OPEN_CONSENT_EVENT, open);
    return () => window.removeEventListener(OPEN_CONSENT_EVENT, open);
  }, []);

  useEffect(() => {
    if (!PIXEL_ENABLED || consent !== "granted") return;
    const env = browserPixelEnvironment();
    if (pageView && !pageViewTracked) {
      pageViewTracked = trackMetaEvent(env, META_PIXEL_ID, "PageView", { content_category: funnel });
    } else {
      loadPixel(env, META_PIXEL_ID);
    }
  }, [consent, funnel, pageView]);

  if (!PIXEL_ENABLED || consent === "server" || (consent !== "unset" && !reopened)) return null;

  const choose = (state: ConsentState) => {
    setConsent(browserPixelEnvironment(), state);
    setReopened(false);
  };

  return (
    <section className={styles.banner} role="region" aria-label="Cookie consent">
      <p>
        <strong>Cookies on this site.</strong> With your permission we use the Meta Pixel and marketing cookies to
        measure how our ads perform, which shares your visit and, if you submit the form, your contact details with
        Meta in hashed form. You can change this anytime under “Cookie preferences” at the bottom of the page.
      </p>
      <div className={styles.actions}>
        <button type="button" className={`${styles.button} ${styles.accept}`} onClick={() => choose("granted")}>
          Accept
        </button>
        <button type="button" className={`${styles.button} ${styles.decline}`} onClick={() => choose("denied")}>
          Decline
        </button>
      </div>
    </section>
  );
}

/**
 * Browser Purchase for a server-verified payment. Uses the order's txnid as eventID, so a
 * reloaded thank-you page does not count again and Meta pairs it with the server event.
 */
export function MetaPurchase({ eventId, value, currency }: { eventId: string; value: number; currency: string }) {
  const consent = useConsent();
  useEffect(() => {
    if (!PIXEL_ENABLED || consent !== "granted") return;
    trackMetaEvent(
      browserPixelEnvironment(),
      META_PIXEL_ID,
      "Purchase",
      { value, currency, content_name: META_CONTENT_NAME, content_category: "paid" },
      eventId
    );
  }, [consent, eventId, value, currency]);
  return null;
}

/** Reopens the consent banner so a visitor can change or withdraw consent. */
export function CookiePreferencesButton() {
  if (!PIXEL_ENABLED) return null;
  return (
    <button
      type="button"
      className={styles.preferences}
      onClick={() => window.dispatchEvent(new Event(OPEN_CONSENT_EVENT))}
    >
      Cookie preferences
    </button>
  );
}
