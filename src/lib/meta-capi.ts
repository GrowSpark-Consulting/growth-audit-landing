import { createHash } from "crypto";
import { isIP } from "node:net";
import { getSafeCheckoutErrorClass } from "./checkout-diagnostics";
import { parseConsent, readCookie } from "./consent";
import { getDb, isMongoConfigured } from "./db";
import { FREE_COLLECTION } from "./free-submissions";
import { findOrderByTxnid, ORDERS_COLLECTION, type CustomerData, type OrderDocument } from "./orders";
import { FREE_SITE_URL, SITE_URL } from "./site";

/**
 * Meta Conversions API (server-side events). Events are sent only for visitors who
 * accepted marketing cookies, with customer identifiers SHA-256 hashed as Meta requires.
 * The access token is server-only and is sent in the request body, never in a URL or log.
 */

const REQUEST_TIMEOUT_MS = 8_000;
const CLAIM_LEASE_MS = 2 * 60_000;
const CONTENT_NAME = "Business Growth Audit";
const META_COOKIE_PATTERN = /^fb\.\d+\.\d+\.[A-Za-z0-9_.-]+$/;

/** Captured from the visitor's request; its presence means consent was granted. */
export interface MetaTrackingContext {
  consent: "granted";
  fbp?: string;
  fbc?: string;
  clientIp?: string;
  userAgent?: string;
  eventSourceUrl?: string;
}

function metaCookie(cookieHeader: string | null, name: string): string | undefined {
  const value = readCookie(cookieHeader, name);
  return value && value.length <= 500 && META_COOKIE_PATTERN.test(value) ? value : undefined;
}

function pageUrl(referer: string | null): string | undefined {
  if (!referer) return undefined;
  try {
    const url = new URL(referer);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    // Origin and path only: query strings can carry personal data.
    return `${url.origin}${url.pathname}`;
  } catch {
    return undefined;
  }
}

/** Returns null unless the visitor accepted marketing cookies. */
export function readMetaTrackingContext(headers: Headers): MetaTrackingContext | null {
  const cookieHeader = headers.get("cookie");
  if (parseConsent(cookieHeader) !== "granted") return null;

  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim() || headers.get("x-real-ip")?.trim();
  const clientIp = forwarded && isIP(forwarded) ? forwarded : undefined;
  const userAgent = headers.get("user-agent")?.slice(0, 512) || undefined;
  const context: MetaTrackingContext = { consent: "granted" };
  const fbp = metaCookie(cookieHeader, "_fbp");
  const fbc = metaCookie(cookieHeader, "_fbc");
  const eventSourceUrl = pageUrl(headers.get("referer"));
  if (fbp) context.fbp = fbp;
  if (fbc) context.fbc = fbc;
  if (clientIp) context.clientIp = clientIp;
  if (userAgent) context.userAgent = userAgent;
  if (eventSourceUrl) context.eventSourceUrl = eventSourceUrl;
  return context;
}

export interface MetaCapiConfig {
  pixelId: string;
  accessToken: string;
  apiVersion: string;
  testEventCode?: string;
}

export function getMetaCapiConfig(): MetaCapiConfig | null {
  const pixelId = process.env.NEXT_PUBLIC_META_PIXEL_ID?.trim() ?? "";
  const accessToken = process.env.META_CAPI_ACCESS_TOKEN?.trim() ?? "";
  const apiVersion = process.env.META_GRAPH_API_VERSION?.trim() || "v24.0";
  if (!/^\d{6,20}$/.test(pixelId) || !accessToken || !/^v\d+\.\d+$/.test(apiVersion)) return null;
  const testEventCode = process.env.META_TEST_EVENT_CODE?.trim();
  return { pixelId, accessToken, apiVersion, ...(testEventCode ? { testEventCode } : {}) };
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function normalizeEmailForMeta(email: string): string {
  return email.trim().toLowerCase();
}

/** Digits with country code, no "+" or leading zeros; 10-digit numbers are Indian mobiles. */
export function normalizePhoneForMeta(phone: string): string {
  const digits = phone.replace(/\D/g, "").replace(/^0+/, "");
  return digits.length === 10 ? `91${digits}` : digits;
}

/** Lowercase letters only, as Meta specifies for first and last names. */
export function normalizeNameForMeta(name: string): string {
  return name.normalize("NFC").toLowerCase().replace(/[^\p{L}]/gu, "");
}

export function buildMetaUserData(
  customer: Pick<CustomerData, "email" | "phone" | "name">,
  context: MetaTrackingContext
): Record<string, string | string[]> {
  const words = customer.name.trim().split(/\s+/).filter(Boolean);
  const firstName = normalizeNameForMeta(words[0] ?? "");
  const lastName = words.length > 1 ? normalizeNameForMeta(words[words.length - 1]) : "";
  const phone = normalizePhoneForMeta(customer.phone);

  const userData: Record<string, string | string[]> = {
    em: [sha256Hex(normalizeEmailForMeta(customer.email))],
  };
  if (phone) userData.ph = [sha256Hex(phone)];
  if (firstName) userData.fn = [sha256Hex(firstName)];
  if (lastName) userData.ln = [sha256Hex(lastName)];
  // Meta requires these unhashed.
  if (context.clientIp) userData.client_ip_address = context.clientIp;
  if (context.userAgent) userData.client_user_agent = context.userAgent;
  if (context.fbp) userData.fbp = context.fbp;
  if (context.fbc) userData.fbc = context.fbc;
  return userData;
}

export interface MetaServerEvent {
  event_name: "Lead" | "Purchase";
  event_time: number;
  event_id: string;
  action_source: "website";
  event_source_url: string;
  user_data: Record<string, string | string[]>;
  custom_data: Record<string, string | number>;
}

/** event_id equals the browser Pixel's eventID (the submission reference) for deduplication. */
export function buildFreeLeadEvent(
  submission: { submissionId: string; customer: CustomerData },
  context: MetaTrackingContext,
  now: Date
): MetaServerEvent {
  return {
    event_name: "Lead",
    event_time: Math.floor(now.getTime() / 1000),
    event_id: submission.submissionId,
    action_source: "website",
    event_source_url: context.eventSourceUrl ?? `${FREE_SITE_URL}/`,
    user_data: buildMetaUserData(submission.customer, context),
    custom_data: { content_name: CONTENT_NAME, content_category: "free" },
  };
}

/** event_id equals the browser Pixel's eventID (the order's txnid) for deduplication. */
export function buildPurchaseEvent(
  order: Pick<OrderDocument, "txnid" | "amount" | "currency" | "customer">,
  context: MetaTrackingContext,
  now: Date
): MetaServerEvent {
  return {
    event_name: "Purchase",
    event_time: Math.floor(now.getTime() / 1000),
    event_id: order.txnid,
    action_source: "website",
    event_source_url: context.eventSourceUrl ?? `${SITE_URL}/`,
    user_data: buildMetaUserData(order.customer, context),
    custom_data: {
      currency: order.currency,
      value: order.amount,
      content_name: CONTENT_NAME,
      content_category: "paid",
      order_id: order.txnid,
    },
  };
}

export type MetaSendResult = { ok: true } | { ok: false; error: string };

export async function sendMetaEvents(
  events: MetaServerEvent[],
  config: MetaCapiConfig,
  fetchImpl: typeof fetch = fetch
): Promise<MetaSendResult> {
  try {
    const response = await fetchImpl(`https://graph.facebook.com/${config.apiVersion}/${config.pixelId}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        data: events,
        access_token: config.accessToken,
        ...(config.testEventCode ? { test_event_code: config.testEventCode } : {}),
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const json = (await response.json().catch(() => null)) as {
      events_received?: unknown;
      error?: { code?: unknown; fbtrace_id?: unknown };
    } | null;
    if (response.ok && typeof json?.events_received === "number" && json.events_received >= events.length) {
      return { ok: true };
    }
    const code = typeof json?.error?.code === "number" ? `_${json.error.code}` : "";
    return { ok: false, error: `META_HTTP_${response.status}${code}` };
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    return { ok: false, error: name === "TimeoutError" || name === "AbortError" ? "META_TIMEOUT" : "META_NETWORK_ERROR" };
  }
}

// ---- Exactly-once delivery ----------------------------------------------------

export type MetaDeliveryKind = "lead" | "purchase";

/** Marks each server event sent at most once, even across repeated triggers. */
export interface MetaDeliveryStore {
  claim(kind: MetaDeliveryKind, id: string, now: Date): Promise<boolean>;
  markSent(kind: MetaDeliveryKind, id: string, now: Date): Promise<void>;
  release(kind: MetaDeliveryKind, id: string): Promise<void>;
}

const DELIVERY_FIELDS = {
  lead: { collection: FREE_COLLECTION, key: "submissionId", claimed: "meta.leadClaimedAt", sent: "meta.leadSentAt" },
  purchase: { collection: ORDERS_COLLECTION, key: "txnid", claimed: "meta.purchaseClaimedAt", sent: "meta.purchaseSentAt" },
} as const;

export function createMongoMetaDeliveryStore(): MetaDeliveryStore {
  const collection = async (kind: MetaDeliveryKind) => (await getDb()).collection(DELIVERY_FIELDS[kind].collection);
  return {
    async claim(kind, id, now) {
      const { key, claimed, sent } = DELIVERY_FIELDS[kind];
      const claimedDoc = await (await collection(kind)).findOneAndUpdate(
        {
          [key]: id,
          [sent]: null,
          $or: [{ [claimed]: null }, { [claimed]: { $lt: new Date(now.getTime() - CLAIM_LEASE_MS) } }],
        },
        { $set: { [claimed]: now } }
      );
      return Boolean(claimedDoc);
    },
    async markSent(kind, id, now) {
      const { key, sent } = DELIVERY_FIELDS[kind];
      await (await collection(kind)).updateOne({ [key]: id }, { $set: { [sent]: now } });
    },
    async release(kind, id) {
      const { key, claimed, sent } = DELIVERY_FIELDS[kind];
      await (await collection(kind)).updateOne({ [key]: id, [sent]: null }, { $unset: { [claimed]: "" } });
    },
  };
}

export interface MetaDeliveryDeps {
  store: MetaDeliveryStore;
  config: () => MetaCapiConfig | null;
  send: (events: MetaServerEvent[], config: MetaCapiConfig) => Promise<MetaSendResult>;
  now: () => Date;
}

export const defaultMetaDeliveryDeps: MetaDeliveryDeps = {
  store: createMongoMetaDeliveryStore(),
  config: getMetaCapiConfig,
  send: sendMetaEvents,
  now: () => new Date(),
};

export type MetaDeliveryOutcome = "sent" | "already_sent" | "no_consent" | "not_paid" | "not_configured" | "failed";

let notConfiguredLogged = false;

async function deliverOnce(
  kind: MetaDeliveryKind,
  id: string,
  build: (now: Date) => MetaServerEvent,
  deps: MetaDeliveryDeps
): Promise<MetaDeliveryOutcome> {
  const config = deps.config();
  if (!config) {
    if (!notConfiguredLogged) {
      notConfiguredLogged = true;
      console.warn("[META_CAPI] Conversions API is not configured; server events are skipped.");
    }
    return "not_configured";
  }
  if (!(await deps.store.claim(kind, id, deps.now()))) return "already_sent";

  const result = await deps.send([build(deps.now())], config);
  if (!result.ok) {
    await deps.store.release(kind, id).catch(() => undefined);
    console.warn("[META_CAPI] Event not accepted.", { kind, id, error: result.error });
    return "failed";
  }
  // If this write fails the claim expires and a later trigger may resend; Meta drops the copy by event_id.
  await deps.store.markSent(kind, id, deps.now()).catch(() => undefined);
  console.info("[META_CAPI] Event sent.", { kind, id });
  return "sent";
}

/** Server Lead for a saved free-page submission; only with consent, at most once per submission. */
export async function sendFreeLeadConversion(
  submission: { submissionId: string; customer: CustomerData },
  context: MetaTrackingContext | null,
  deps: MetaDeliveryDeps = defaultMetaDeliveryDeps
): Promise<MetaDeliveryOutcome> {
  if (!context) return "no_consent";
  return deliverOnce("lead", submission.submissionId, (now) => buildFreeLeadEvent(submission, context, now), deps);
}

/** Server Purchase for a server-verified PAID order whose checkout had consent; at most once. */
export async function sendPurchaseConversion(
  order: OrderDocument | null,
  deps: MetaDeliveryDeps = defaultMetaDeliveryDeps
): Promise<MetaDeliveryOutcome> {
  if (!order || order.status !== "PAID") return "not_paid";
  const context = order.tracking;
  if (!context) return "no_consent";
  return deliverOnce("purchase", order.txnid, (now) => buildPurchaseEvent(order, context, now), deps);
}

/** Never throws; for after() callbacks that must not affect the response. */
export async function sendFreeLeadConversionSafely(
  submission: { submissionId: string; customer: CustomerData },
  context: MetaTrackingContext | null
): Promise<void> {
  try {
    await sendFreeLeadConversion(submission, context);
  } catch (error) {
    console.error("[META_CAPI] Lead event failed.", { errorClass: getSafeCheckoutErrorClass(error) });
  }
}

/** Never throws; for after() callbacks that must not affect the PayU redirect. */
export async function sendPurchaseConversionSafely(txnid: string): Promise<void> {
  try {
    if (!isMongoConfigured()) return;
    await sendPurchaseConversion(await findOrderByTxnid(txnid));
  } catch (error) {
    console.error("[META_CAPI] Purchase event failed.", { txnid, errorClass: getSafeCheckoutErrorClass(error) });
  }
}
