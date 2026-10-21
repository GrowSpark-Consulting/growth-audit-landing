import { buildConsentCookie, CONSENT_CHANGE_EVENT, parseConsent, type ConsentState } from "./consent";

/** Public by design (it appears in every Pixel request); inlined at build time. */
export const META_PIXEL_ID = process.env.NEXT_PUBLIC_META_PIXEL_ID?.trim() ?? "";
export const META_CONTENT_NAME = "Business Growth Audit";
/** Same as the server-enforced FIXED_ORDER_AMOUNT; client code cannot import orders.ts. */
export const AUDIT_PRICE = 999;
export const AUDIT_CURRENCY = "INR";
/** Sent as `content_category` so paid and free activity can be reported separately. */
export type MetaFunnel = "paid" | "free";

const PIXEL_SCRIPT_SRC = "https://connect.facebook.net/en_US/fbevents.js";

export interface Fbq {
  (...args: unknown[]): void;
  callMethod?: (...args: unknown[]) => void;
  queue: unknown[][];
  push: Fbq;
  loaded: boolean;
  version: string;
}

/** The browser capabilities the Pixel needs, injected so the rules are testable without a DOM. */
export interface PixelEnvironment {
  win: { fbq?: Fbq; _fbq?: Fbq };
  getCookie(): string;
  setCookie(value: string): void;
  injectScript(src: string): void;
  isSecure: boolean;
  hostname: string;
  storage: Pick<Storage, "getItem" | "setItem"> | null;
  emit(name: string, detail: unknown): void;
}

export function isValidPixelId(pixelId: string): boolean {
  return /^\d{6,20}$/.test(pixelId);
}

export function getConsent(env: PixelEnvironment): ConsentState | null {
  return parseConsent(env.getCookie());
}

/**
 * Loads Meta's Pixel only after consent was granted. This is Meta's base code without the
 * automatic PageView, so each page decides which events it sends. Returns false when the
 * Pixel must not run (no consent, or no valid Pixel ID configured).
 */
export function loadPixel(env: PixelEnvironment, pixelId: string): boolean {
  if (!isValidPixelId(pixelId) || getConsent(env) !== "granted") return false;
  if (env.win.fbq) return true;

  const fbq = function (...args: unknown[]) {
    if (fbq.callMethod) fbq.callMethod(...args);
    else fbq.queue.push(args);
  } as Fbq;
  fbq.push = fbq;
  fbq.loaded = true;
  fbq.version = "2.0";
  fbq.queue = [];
  env.win.fbq = fbq;
  if (!env.win._fbq) env.win._fbq = fbq;
  env.injectScript(PIXEL_SCRIPT_SRC);
  fbq("init", pixelId);
  return true;
}

function storageHas(storage: PixelEnvironment["storage"], key: string): boolean {
  try {
    const value = storage?.getItem(key);
    return value !== null && value !== undefined;
  } catch {
    return false;
  }
}

function storageMark(storage: PixelEnvironment["storage"], key: string): void {
  try {
    storage?.setItem(key, "1");
  } catch {
    // Storage blocked (private mode): Meta still deduplicates by eventID.
  }
}

/**
 * Sends one Pixel event when consent allows. An event with an eventId is sent at most once per
 * browser (a reloaded thank-you page does not repeat Purchase); the same eventId on the server
 * event lets Meta deduplicate the browser and Conversions API copies.
 */
export function trackMetaEvent(
  env: PixelEnvironment,
  pixelId: string,
  name: string,
  params: Record<string, unknown>,
  eventId?: string
): boolean {
  if (!loadPixel(env, pixelId)) return false;
  if (eventId) {
    const key = `gs_meta:${name}:${eventId}`;
    if (storageHas(env.storage, key)) return false;
    storageMark(env.storage, key);
    env.win.fbq?.("track", name, params, { eventID: eventId });
  } else {
    env.win.fbq?.("track", name, params);
  }
  return true;
}

function clearMetaCookies(env: PixelEnvironment): void {
  const labels = env.hostname.split(".");
  // Meta sets _fbp/_fbc on the registrable domain; try every parent except the TLD.
  const domains = [undefined, ...labels.slice(0, -1).map((_, i) => `.${labels.slice(i).join(".")}`)];
  for (const name of ["_fbp", "_fbc"]) {
    for (const domain of domains) {
      env.setCookie(`${name}=; Path=/; Max-Age=0${domain ? `; Domain=${domain}` : ""}`);
    }
  }
}

/** Records the visitor's choice. Declining stops the Pixel and removes Meta's cookies. */
export function setConsent(env: PixelEnvironment, state: ConsentState): void {
  env.setCookie(buildConsentCookie(state, env.isSecure));
  env.win.fbq?.("consent", state === "granted" ? "grant" : "revoke");
  if (state === "denied") clearMetaCookies(env);
  env.emit(CONSENT_CHANGE_EVENT, state);
}

export function browserPixelEnvironment(): PixelEnvironment {
  let storage: PixelEnvironment["storage"] = null;
  try {
    storage = window.localStorage;
  } catch {
    storage = null;
  }
  return {
    win: window as unknown as PixelEnvironment["win"],
    getCookie: () => document.cookie,
    setCookie: (value) => {
      document.cookie = value;
    },
    injectScript: (src) => {
      const script = document.createElement("script");
      script.async = true;
      script.src = src;
      document.head.appendChild(script);
    },
    isSecure: window.location.protocol === "https:",
    hostname: window.location.hostname,
    storage,
    emit: (name, detail) => {
      window.dispatchEvent(new CustomEvent(name, { detail }));
    },
  };
}
