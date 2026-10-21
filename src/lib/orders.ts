import { Collection, ObjectId, type Filter, type UpdateFilter } from "mongodb";
import { randomBytes } from "crypto";
import { getDb, isMongoConfigured } from "./db";
import type { MetaTrackingContext } from "./meta-capi";
import { LEAD_SOURCE_PAID, type ZohoLeadSource } from "./zoho";

export const FIXED_ORDER_AMOUNT = 999.0;
export const FIXED_ORDER_CURRENCY = "INR";
export const FIXED_PRODUCT_NAME = "Business Growth Audit";

export const TEAM_SIZES = ["1-5", "6-15", "16-30", "31-75", "76+"] as const;
export const INDUSTRIES = [
  "Professional services",
  "Technology & software",
  "Manufacturing",
  "Retail & e-commerce",
  "Healthcare & wellness",
  "Financial services",
  "Education & training",
  "Construction & real estate",
  "Hospitality & food",
  "Other",
] as const;
export const REVENUES = [
  "Below ₹50 lakh",
  "₹50 lakh-₹1 crore",
  "₹1-2 crore",
  "₹2-3 crore",
  "₹3-5 crore",
  "Above ₹5 crore",
  "Prefer to discuss",
] as const;
export const CHALLENGES = [
  "Revenue is growing, but profit is not",
  "Stuck at the same revenue for years",
  "My revenue is going down every year",
  "Another business challenge",
] as const;

export type OrderStatus = "PENDING" | "PAID" | "FAILED" | "CANCELLED";

export interface CustomerData {
  name: string;
  phone: string;
  email: string;
  company: string;
  website?: string;
  team: string;
  industry: string;
  revenue: string;
  businessProblem: string;
}

export interface PayUDetails {
  mihpayid?: string;
  mode?: string;
  status?: string;
  unmappedstatus?: string;
  bankRefNum?: string;
  bankcode?: string;
  error?: string;
  errorMessage?: string;
  additionalCharges?: string;
  rawResponseHash?: string;
  verifiedAt?: Date;
  /** Per-recipient delivery state: a leased claim, then confirmed once Resend accepts it. */
  customerEmailClaimedAt?: Date;
  customerEmailSent?: boolean;
  teamEmailClaimedAt?: Date;
  teamEmailSent?: boolean;
}

export type ZohoSyncStatus = "PENDING" | "SYNCED" | "RETRY_REQUIRED" | "FAILED";

export interface ZohoSyncState {
  status: ZohoSyncStatus;
  attempts: number;
  leadId?: string;
  leadSource?: ZohoLeadSource;
  lastError?: string;
  lastAttemptAt?: Date;
  syncedAt?: Date;
  nextRetryAt?: Date;
  lockedUntil?: Date;
}

export interface OrderDocument {
  _id?: ObjectId;
  txnid: string;
  amount: number;
  currency: string;
  productInfo: string;
  customer: CustomerData;
  status: OrderStatus;
  payu?: PayUDetails;
  zoho?: ZohoSyncState;
  /** Stored only when the visitor accepted marketing cookies at checkout. */
  tracking?: MetaTrackingContext;
  meta?: { purchaseClaimedAt?: Date; purchaseSentAt?: Date };
  createdAt: Date;
  updatedAt: Date;
}

export const ORDERS_COLLECTION = "orders";

export async function getOrdersCollection(): Promise<Collection<OrderDocument>> {
  const db = await getDb();
  return db.collection<OrderDocument>(ORDERS_COLLECTION);
}

let indexesEnsured = false;

/**
 * Ensures unique and search indexes on the orders collection.
 * Called automatically during order creation or can be run as a setup task.
 */
export async function ensureOrderIndexes(): Promise<void> {
  if (indexesEnsured || !isMongoConfigured()) return;
  const col = await getOrdersCollection();
  await col.createIndex({ txnid: 1 }, { unique: true, name: "uniq_txnid" });
  await col.createIndex({ createdAt: -1 }, { name: "idx_created_at" });
  await col.createIndex({ status: 1 }, { name: "idx_status" });
  await col.createIndex({ "zoho.status": 1, createdAt: 1 }, { name: "idx_zoho_status_created" });
  await col.createIndex({ "customer.email": 1, createdAt: -1 }, { name: "idx_customer_email" });
  indexesEnsured = true;
}

/**
 * Generates an unpredictable, merchant-unique transaction identifier.
 * Example format: GSA_1713340000000_a1b2c3d4
 */
export function generateTransactionId(): string {
  const timestamp = Date.now();
  const randomSuffix = randomBytes(4).toString("hex");
  return `GSA_${timestamp}_${randomSuffix}`;
}

/**
 * Validates and normalizes customer input from the lead form.
 */
export function validateCustomerInput(input: Partial<CustomerData>): {
  valid: boolean;
  errors: string[];
  data?: CustomerData;
} {
  const errors: string[] = [];

  const name = (input.name ?? "").trim();
  if (!name || name.length < 2 || name.length > 100) {
    errors.push("Full name is required (between 2 and 100 characters).");
  }

  const rawPhone = (input.phone ?? "").trim();
  // Strip spaces, dashes, parentheses
  const sanitizedPhone = rawPhone.replace(/[\s\-()]/g, "");
  const digitsOnly = sanitizedPhone.replace(/^\+/, "");
  if (!/^\+?\d{10,15}$/.test(sanitizedPhone) || digitsOnly.length < 10) {
    errors.push("A valid phone number with at least 10 digits is required.");
  }

  const email = (input.email ?? "").trim().toLowerCase();
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!email || !emailRegex.test(email) || email.length > 150) {
    errors.push("A valid work email address is required.");
  }

  const company = (input.company ?? "").trim();
  if (!company || company.length < 2 || company.length > 100) {
    errors.push("Company name is required (between 2 and 100 characters).");
  }

  let website: string | undefined = (input.website ?? "").trim();
  if (website) {
    if (!website.startsWith("http://") && !website.startsWith("https://")) {
      website = `https://${website}`;
    }
    let hostname = "";
    try {
      hostname = new URL(website).hostname;
    } catch {
      hostname = "";
    }
    if (!/^([a-z0-9-]+\.)+[a-z]{2,}$/i.test(hostname) || website.length > 255) {
      errors.push("Please provide a valid website URL or leave blank.");
    }
  } else {
    website = undefined;
  }

  const team = (input.team ?? "").trim();
  if (!TEAM_SIZES.includes(team as (typeof TEAM_SIZES)[number])) {
    errors.push("Please select a valid team size option.");
  }

  const industry = (input.industry ?? "").trim();
  if (!INDUSTRIES.includes(industry as (typeof INDUSTRIES)[number])) {
    errors.push("Please select a valid industry option.");
  }

  const revenue = (input.revenue ?? "").trim();
  if (!REVENUES.includes(revenue as (typeof REVENUES)[number])) {
    errors.push("Please select a valid revenue range option.");
  }

  const businessProblem = (input.businessProblem ?? "").trim();
  if (!CHALLENGES.includes(businessProblem as (typeof CHALLENGES)[number])) {
    errors.push("Please select a valid business challenge option.");
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    errors: [],
    data: {
      name,
      phone: rawPhone,
      email,
      company,
      website,
      team,
      industry,
      revenue,
      businessProblem,
    },
  };
}

/**
 * Creates and persists a new pending order.
 */
export async function createOrder(
  customer: CustomerData,
  tracking?: MetaTrackingContext
): Promise<OrderDocument> {
  const txnid = generateTransactionId();
  const now = new Date();

  const orderDoc: OrderDocument = {
    txnid,
    amount: FIXED_ORDER_AMOUNT,
    currency: FIXED_ORDER_CURRENCY,
    productInfo: FIXED_PRODUCT_NAME,
    customer,
    status: "PENDING",
    zoho: { status: "PENDING", attempts: 0 },
    // The PayU callback arrives without the site's cookies, so the consented browser
    // identifiers needed for the server-side Purchase event are kept from checkout.
    ...(tracking ? { tracking } : {}),
    createdAt: now,
    updatedAt: now,
  };

  if (!isMongoConfigured()) {
    throw new Error("MongoDB must be configured to create a payable order.");
  }

  await ensureOrderIndexes();
  const col = await getOrdersCollection();
  const result = await col.insertOne(orderDoc);
  orderDoc._id = result.insertedId;

  return orderDoc;
}

/**
 * Retrieves an order by its unique transaction id.
 */
export async function findOrderByTxnid(txnid: string): Promise<OrderDocument | null> {
  if (!isMongoConfigured()) return null;
  const col = await getOrdersCollection();
  return col.findOne({ txnid });
}

/**
 * Updates an order status and PayU payment details idempotently.
 * Transitions from PENDING -> PAID or PENDING -> FAILED.
 * Once marked PAID, an order cannot be overwritten to FAILED by duplicate callbacks.
 */
export async function updateOrderStatus(
  txnid: string,
  newStatus: Exclude<OrderStatus, "PENDING" | "CANCELLED">,
  payuDetails: PayUDetails
): Promise<{ success: boolean; order: OrderDocument | null; alreadyPaid?: boolean }> {
  if (!isMongoConfigured()) {
    return { success: false, order: null };
  }

  const col = await getOrdersCollection();
  const existing = await col.findOne({ txnid });

  if (!existing) {
    return { success: false, order: null };
  }

  if (existing.status === "PAID") {
    // Idempotency: Already paid, do not revert or re-process
    return { success: true, order: existing, alreadyPaid: true };
  }

  const now = new Date();
  const updateResult = await col.findOneAndUpdate(
    { txnid, status: { $ne: "PAID" } },
    {
      $set: {
        status: newStatus,
        payu: {
          ...existing.payu,
          ...payuDetails,
          verifiedAt: now,
        },
        updatedAt: now,
      },
    },
    { returnDocument: "after" }
  );

  // A concurrent success callback may have changed the row to PAID after the
  // initial read. Read the winning state instead of returning the stale copy.
  const persistedOrder = updateResult ?? (await col.findOne({ txnid }));

  return {
    success: Boolean(persistedOrder),
    order: persistedOrder,
    alreadyPaid: !updateResult && persistedOrder?.status === "PAID",
  };
}

export type PaymentEmailKind = "customer" | "team";

/** A claim blocks other attempts for this long; after that it may be reclaimed. */
export const EMAIL_CLAIM_LEASE_MS = 2 * 60 * 1000;

const EMAIL_FIELDS = {
  customer: { sent: "payu.customerEmailSent", claimedAt: "payu.customerEmailClaimedAt" },
  team: { sent: "payu.teamEmailSent", claimedAt: "payu.teamEmailClaimedAt" },
} as const;

/**
 * Atomically claims one payment email for a PAID order and returns the claim
 * timestamp, or null. Succeeds only if the email is not confirmed sent and has no
 * claim, or its claim is older than the lease. One conditional findOneAndUpdate,
 * so concurrent callers cannot both claim an active email.
 */
export async function claimPaymentEmail(
  txnid: string,
  kind: PaymentEmailKind,
  now: Date = new Date()
): Promise<Date | null> {
  if (!isMongoConfigured()) return null;
  const col = await getOrdersCollection();
  const { sent, claimedAt } = EMAIL_FIELDS[kind];
  const cutoff = new Date(now.getTime() - EMAIL_CLAIM_LEASE_MS);
  const claimed = await col.findOneAndUpdate(
    {
      txnid,
      status: "PAID",
      [sent]: { $ne: true },
      // `null` also matches a missing field.
      $or: [{ [claimedAt]: null }, { [claimedAt]: { $lt: cutoff } }],
    },
    { $set: { [claimedAt]: now } }
  );
  return claimed ? now : null;
}

/** Records that Resend accepted the email, so it is never claimed again. */
export async function markPaymentEmailSent(
  txnid: string,
  kind: PaymentEmailKind
): Promise<void> {
  if (!isMongoConfigured()) return;
  const col = await getOrdersCollection();
  await col.updateOne({ txnid, status: "PAID" }, { $set: { [EMAIL_FIELDS[kind].sent]: true } });
}

/**
 * Clears this caller's claim after a failed send so a later callback can retry
 * immediately. Matches on the claim timestamp, so it never clears a claim that
 * another attempt has since taken over.
 */
export async function releasePaymentEmailClaim(
  txnid: string,
  kind: PaymentEmailKind,
  claimedAt: Date
): Promise<void> {
  if (!isMongoConfigured()) return;
  const col = await getOrdersCollection();
  const fields = EMAIL_FIELDS[kind];
  await col.updateOne(
    { txnid, status: "PAID", [fields.sent]: { $ne: true }, [fields.claimedAt]: claimedAt },
    { $unset: { [fields.claimedAt]: "" } }
  );
}

/**
 * PAID orders whose customer or team email is not confirmed sent, for the recovery
 * cron. Paid between `maxAgeMs` and `minAgeMs` ago (by verification time), newest
 * first so old, persistently failing orders cannot starve recent ones.
 */
export async function findPaidOrdersWithUnsentEmails(options: {
  now: Date;
  minAgeMs: number;
  maxAgeMs: number;
  /** Orders verified before this are never picked up (the feature's go-live time). */
  notBefore: Date;
  limit: number;
}): Promise<OrderDocument[]> {
  if (!isMongoConfigured()) return [];
  const col = await getOrdersCollection();
  const windowStart = Math.max(
    options.now.getTime() - options.maxAgeMs,
    options.notBefore.getTime()
  );
  return col
    .find({
      status: "PAID",
      "payu.verifiedAt": {
        $gte: new Date(windowStart),
        $lte: new Date(options.now.getTime() - options.minAgeMs),
      },
      $or: [
        { "payu.customerEmailSent": { $ne: true } },
        { "payu.teamEmailSent": { $ne: true } },
      ],
    })
    .sort({ "payu.verifiedAt": -1 })
    .limit(options.limit)
    .toArray();
}

const ZOHO_SYNC_LEASE_MS = 90_000;
const ZOHO_STALE_PENDING_MS = 2 * 60_000;

export interface ZohoSyncUpdate {
  status: ZohoSyncStatus;
  countAttempt: boolean;
  leadId?: string;
  leadSource?: ZohoLeadSource;
  error?: string;
  nextRetryAt?: Date;
  /** Skip the write if payment was confirmed while the sync was running. */
  onlyIfNotPaid?: boolean;
}

/**
 * Atomically leases an order for CRM sync so concurrent callers (checkout,
 * PayU callbacks, the retry job) never push the same submission in parallel.
 * Returns null when the order is missing or another caller holds the lease.
 */
export async function claimOrderForZohoSync(
  txnid: string,
  now = new Date()
): Promise<OrderDocument | null> {
  if (!isMongoConfigured()) return null;
  const col = await getOrdersCollection();
  return col.findOneAndUpdate(
    {
      txnid,
      $or: [{ "zoho.lockedUntil": { $exists: false } }, { "zoho.lockedUntil": { $lte: now } }],
    },
    { $set: { "zoho.lockedUntil": new Date(now.getTime() + ZOHO_SYNC_LEASE_MS) } },
    { returnDocument: "after" }
  );
}

export async function releaseZohoSyncClaim(txnid: string): Promise<void> {
  const col = await getOrdersCollection();
  await col.updateOne({ txnid }, { $unset: { "zoho.lockedUntil": "" } });
}

/** Persists a sync result and releases the lease. Returns false when no order matched. */
export async function saveZohoSyncResult(
  txnid: string,
  update: ZohoSyncUpdate,
  now = new Date()
): Promise<boolean> {
  const set: Record<string, unknown> = { "zoho.status": update.status, "zoho.lastAttemptAt": now };
  const unset: Record<string, ""> = { "zoho.lockedUntil": "" };
  if (update.leadId) set["zoho.leadId"] = update.leadId;
  if (update.leadSource) set["zoho.leadSource"] = update.leadSource;
  if (update.status === "SYNCED") set["zoho.syncedAt"] = now;
  if (update.error) set["zoho.lastError"] = update.error;
  else unset["zoho.lastError"] = "";
  if (update.nextRetryAt) set["zoho.nextRetryAt"] = update.nextRetryAt;
  else unset["zoho.nextRetryAt"] = "";

  const filter: Filter<OrderDocument> = update.onlyIfNotPaid
    ? { txnid, status: { $ne: "PAID" } }
    : { txnid };
  const col = await getOrdersCollection();
  const result = await col.updateOne(filter, {
    $set: set,
    $unset: unset,
    ...(update.countAttempt ? { $inc: { "zoho.attempts": 1 } } : {}),
  } as UpdateFilter<OrderDocument>);
  return result.matchedCount > 0;
}

/** Zoho Lead ID of the most recent other submission with this email, if one was synced. */
export async function findZohoLeadIdForEmail(email: string, excludeTxnid: string): Promise<string | null> {
  if (!isMongoConfigured()) return null;
  const col = await getOrdersCollection();
  const match = await col.findOne(
    { "customer.email": email, txnid: { $ne: excludeTxnid }, "zoho.leadId": { $exists: true } },
    { sort: { createdAt: -1 }, projection: { "zoho.leadId": 1 } }
  );
  return match?.zoho?.leadId ?? null;
}

/**
 * Lists submissions whose CRM sync should be (re)attempted: stale PENDING syncs,
 * due retries, and paid orders whose Lead has not been upgraded yet. FAILED
 * syncs are excluded until they are requeued manually.
 */
export async function findOrdersDueForZohoSync(limit: number, now = new Date()): Promise<string[]> {
  if (!isMongoConfigured()) return [];
  const col = await getOrdersCollection();
  const due = await col
    .find(
      {
        $or: [
          {
            "zoho.status": "PENDING",
            createdAt: { $lte: new Date(now.getTime() - ZOHO_STALE_PENDING_MS) },
          },
          {
            "zoho.status": "RETRY_REQUIRED",
            $or: [{ "zoho.nextRetryAt": { $exists: false } }, { "zoho.nextRetryAt": { $lte: now } }],
          },
          { status: "PAID", "zoho.status": "SYNCED", "zoho.leadSource": { $ne: LEAD_SOURCE_PAID } },
        ],
      },
      { projection: { txnid: 1 }, sort: { createdAt: 1 }, limit }
    )
    .toArray();
  return due.map((order) => order.txnid);
}
