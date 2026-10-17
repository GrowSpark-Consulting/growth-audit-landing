import crypto from "crypto";
import { isIP } from "node:net";
import { getSiteUrl } from "./site";

export class PayUConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PayUConfigurationError";
  }
}

export interface PayUConfig {
  key: string;
  salt: string;
  mode: "test" | "production";
  paymentUrl: string;
}

function readPayUMode(): "test" | "production" {
  const mode = process.env.PAYU_MODE;
  if (mode !== "test" && mode !== "production") {
    throw new PayUConfigurationError(
      "PAYU_MODE must be explicitly set to 'test' or 'production'."
    );
  }
  return mode;
}

function getPayUCredentials(mode: "test" | "production") {
  if (mode === "production") {
    return {
      key: process.env.PAYU_PRODUCTION_MERCHANT_KEY || "",
      salt: process.env.PAYU_PRODUCTION_MERCHANT_SALT || "",
    };
  }

  return {
    // Keep existing local sandbox setups working. These legacy variables are
    // deliberately ignored in production mode.
    key: process.env.PAYU_TEST_MERCHANT_KEY || process.env.PAYU_MERCHANT_KEY || "",
    salt: process.env.PAYU_TEST_MERCHANT_SALT || process.env.PAYU_MERCHANT_SALT || "",
  };
}

export function getPayUCallbackBaseUrl(mode: "test" | "production"): string {
  const configuredSiteUrl = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  const siteUrl = getSiteUrl();

  if (mode === "test") return siteUrl;

  if (!configuredSiteUrl) {
    throw new PayUConfigurationError(
      "NEXT_PUBLIC_SITE_URL must be configured for production callbacks."
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(siteUrl);
  } catch {
    throw new PayUConfigurationError(
      "NEXT_PUBLIC_SITE_URL must be a valid public HTTPS URL in production."
    );
  }

  const hostname = parsed.hostname.toLowerCase();
  const unbracketedHostname = hostname.replace(/^\[|\]$/g, "");
  const isIpAddress = isIP(unbracketedHostname) !== 0;
  const localOrTunnelHost =
    hostname === "localhost" ||
    hostname === "0.0.0.0" ||
    isIpAddress ||
    !hostname.includes(".") ||
    [".local", ".localhost", ".internal", ".test", ".example", ".invalid"].some((suffix) => hostname.endsWith(suffix)) ||
    hostname.includes("ngrok") ||
    hostname.endsWith(".loca.lt") ||
    hostname.endsWith(".localtunnel.me") ||
    hostname.endsWith(".trycloudflare.com");

  if (
    parsed.protocol !== "https:" ||
    localOrTunnelHost ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new PayUConfigurationError(
      "NEXT_PUBLIC_SITE_URL must be a public HTTPS site origin, not localhost or a tunnel, in production."
    );
  }

  return parsed.origin;
}

export function getPayUConfig(): PayUConfig {
  const mode = readPayUMode();
  const { key, salt } = getPayUCredentials(mode);
  getPayUCallbackBaseUrl(mode);
  const paymentUrl =
    mode === "production"
      ? "https://secure.payu.in/_payment"
      : "https://test.payu.in/_payment";

  return { key, salt, mode, paymentUrl };
}

export function isPayUConfigured(): boolean {
  try {
    const { key, salt } = getPayUConfig();
    return Boolean(
      key &&
        salt &&
        !key.startsWith("your_") &&
        !salt.startsWith("your_")
    );
  } catch {
    return false;
  }
}

export interface PayURequestPayload {
  key: string;
  txnid: string;
  amount: string;
  productinfo: string;
  firstname: string;
  email: string;
  phone: string;
  surl: string;
  furl: string;
  hash: string;
  udf1?: string;
  udf2?: string;
  udf3?: string;
  udf4?: string;
  udf5?: string;
}

/**
 * Computes PayU Hosted Checkout SHA-512 payment request hash.
 * Exact sequence:
 * sha512(key|txnid|amount|productinfo|firstname|email|udf1|udf2|udf3|udf4|udf5||||||SALT)
 */
export function generatePayURequestHash(params: {
  key: string;
  txnid: string;
  amount: string | number;
  productinfo: string;
  firstname: string;
  email: string;
  salt: string;
  udf1?: string;
  udf2?: string;
  udf3?: string;
  udf4?: string;
  udf5?: string;
}): string {
  const formattedAmount =
    typeof params.amount === "number"
      ? params.amount.toFixed(2)
      : parseFloat(params.amount).toFixed(2);

  const udf1 = params.udf1 ?? "";
  const udf2 = params.udf2 ?? "";
  const udf3 = params.udf3 ?? "";
  const udf4 = params.udf4 ?? "";
  const udf5 = params.udf5 ?? "";

  const hashString = `${params.key}|${params.txnid}|${formattedAmount}|${params.productinfo}|${params.firstname}|${params.email}|${udf1}|${udf2}|${udf3}|${udf4}|${udf5}||||||${params.salt}`;

  return crypto.createHash("sha512").update(hashString, "utf8").digest("hex").toLowerCase();
}

/**
 * Prepares the complete PayU Hosted Checkout form payload.
 */
export function buildPayUPaymentPayload(params: {
  txnid: string;
  amount: number;
  productinfo: string;
  name: string;
  email: string;
  phone: string;
  udf1?: string;
  udf2?: string;
  udf3?: string;
  udf4?: string;
  udf5?: string;
}): { action: string; params: PayURequestPayload } {
  const config = getPayUConfig();

  // Extract first name (alphanumeric/simple string without excessive characters)
  const firstname = params.name.trim().split(/\s+/)[0]?.slice(0, 50) || "Customer";
  const formattedAmount = params.amount.toFixed(2);

  const callbackBaseUrl = getPayUCallbackBaseUrl(config.mode);
  const surl = `${callbackBaseUrl}/api/payment/callback`;
  const furl = `${callbackBaseUrl}/api/payment/callback`;

  const hash = generatePayURequestHash({
    key: config.key,
    txnid: params.txnid,
    amount: formattedAmount,
    productinfo: params.productinfo,
    firstname,
    email: params.email,
    salt: config.salt,
    udf1: params.udf1,
    udf2: params.udf2,
    udf3: params.udf3,
    udf4: params.udf4,
    udf5: params.udf5,
  });

  return {
    action: config.paymentUrl,
    params: {
      key: config.key,
      txnid: params.txnid,
      amount: formattedAmount,
      productinfo: params.productinfo,
      firstname,
      email: params.email,
      phone: params.phone,
      surl,
      furl,
      hash,
      udf1: params.udf1 || "",
      udf2: params.udf2 || "",
      udf3: params.udf3 || "",
      udf4: params.udf4 || "",
      udf5: params.udf5 || "",
    },
  };
}

export interface PayUResponseData {
  key?: string;
  txnid?: string;
  amount?: string;
  productinfo?: string;
  firstname?: string;
  email?: string;
  status?: string;
  hash?: string;
  additionalCharges?: string;
  additional_charges?: string;
  udf1?: string;
  udf2?: string;
  udf3?: string;
  udf4?: string;
  udf5?: string;
  [key: string]: unknown;
}

/**
 * Calculates the expected PayU reverse hash for callback verification.
 * Standard sequence:
 * sha512(SALT|status||||||udf5|udf4|udf3|udf2|udf1|email|firstname|productinfo|amount|txnid|key)
 *
 * Sequence with additionalCharges:
 * sha512(additionalCharges|SALT|status||||||udf5|udf4|udf3|udf2|udf1|email|firstname|productinfo|amount|txnid|key)
 */
export function calculatePayUReverseHash(
  data: PayUResponseData,
  salt: string,
  withAdditionalCharges = false
): string {
  const status = data.status ?? "";
  const udf5 = data.udf5 ?? "";
  const udf4 = data.udf4 ?? "";
  const udf3 = data.udf3 ?? "";
  const udf2 = data.udf2 ?? "";
  const udf1 = data.udf1 ?? "";
  const email = data.email ?? "";
  const firstname = data.firstname ?? "";
  const productinfo = data.productinfo ?? "";
  const amount = data.amount ?? "";
  const txnid = data.txnid ?? "";
  const key = data.key ?? "";

  const additionalCharges = (data.additionalCharges || data.additional_charges || "") as string;

  const baseReverse = `${salt}|${status}||||||${udf5}|${udf4}|${udf3}|${udf2}|${udf1}|${email}|${firstname}|${productinfo}|${amount}|${txnid}|${key}`;

  const hashString = withAdditionalCharges && additionalCharges
    ? `${additionalCharges}|${baseReverse}`
    : baseReverse;

  return crypto.createHash("sha512").update(hashString, "utf8").digest("hex").toLowerCase();
}

/**
 * Safely verifies the reverse hash returned by PayU using constant-time comparison.
 * Checks both the additionalCharges variant and standard variant.
 */
export function verifyPayUResponseHash(data: PayUResponseData, salt: string): boolean {
  if (!data.hash || !salt) {
    return false;
  }

  const receivedHash = data.hash.toLowerCase().trim();

  // Try with additional charges if present
  const hasAdditionalCharges = Boolean(data.additionalCharges || data.additional_charges);
  if (hasAdditionalCharges) {
    const hashWithAdditional = calculatePayUReverseHash(data, salt, true);
    if (constantTimeEqual(hashWithAdditional, receivedHash)) {
      return true;
    }
  }

  // Try standard reverse hash
  const standardHash = calculatePayUReverseHash(data, salt, false);
  return constantTimeEqual(standardHash, receivedHash);
}

/**
 * Timing-safe string comparison to protect against timing attacks.
 */
function constantTimeEqual(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") {
    return false;
  }
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Generates an HMAC-SHA256 order verification token.
 * Used to securely verify and display order status on /thank-you without
 * exposing credentials or allowing unauthenticated transaction enumeration.
 */
export function generateOrderVerificationToken(
  txnid: string,
  status: string,
  amount: number | string
): string {
  const secret = getOrderVerificationSecret();
  if (!secret) return "";

  const message = `${txnid}:${status}:${amount}`;
  return crypto.createHmac("sha256", secret).update(message).digest("hex");
}

/**
 * Verifies an HMAC-SHA256 order verification token.
 */
export function verifyOrderVerificationToken(
  txnid: string,
  status: string,
  amount: number | string,
  token: string
): boolean {
  if (!token || !getOrderVerificationSecret()) {
    return false;
  }
  const expectedToken = generateOrderVerificationToken(txnid, status, amount);
  return constantTimeEqual(expectedToken, token.toLowerCase().trim());
}

function getOrderVerificationSecret(): string {
  if (process.env.ORDER_VERIFICATION_SECRET) {
    return process.env.ORDER_VERIFICATION_SECRET;
  }

  try {
    return getPayUConfig().salt;
  } catch {
    return "";
  }
}
