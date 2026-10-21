import { createHash, randomBytes } from "crypto";
import type { Collection } from "mongodb";
import { getSafeCheckoutErrorClass } from "./checkout-diagnostics";
import { getDb, isMongoConfigured } from "./db";
import { sendFreeApplicantConfirmationEmail, sendFreeTeamNotificationEmail } from "./email";
import { findZohoLeadIdForEmail, type CustomerData } from "./orders";
import {
  isZohoConfigured,
  pushFreePageLeadToZoho,
  ZohoError,
  type PushFreePageLeadInput,
  type PushFreePageLeadResult,
} from "./zoho";

/**
 * Free landing page workflow. Deliberately separate from the payment `orders`
 * collection: a free submission never creates an order or contacts the gateway.
 */
export type FreeEmailKind = "applicant" | "team";

export interface FreeSubmissionDocument {
  submissionId: string;
  /** Hash of the normalized form content: an identical retry maps to the same record. */
  payloadHash: string;
  /** payloadHash + 24h bucket; unique index that settles concurrent identical requests. */
  dedupeKey: string;
  customer: CustomerData;
  zoho?: { leadId?: string; syncedAt?: Date; lockedUntil?: Date; attempts: number; lastError?: string };
  applicantEmailClaimedAt?: Date;
  applicantEmailSentAt?: Date;
  teamEmailClaimedAt?: Date;
  teamEmailSentAt?: Date;
  meta?: { leadClaimedAt?: Date; leadSentAt?: Date };
  createdAt: Date;
  updatedAt: Date;
}

export const FREE_COLLECTION = "free_submissions";
export const ZOHO_LEASE_MS = 90_000;
export const EMAIL_LEASE_MS = 2 * 60_000;
const DEDUPE_WINDOW_MS = 24 * 60 * 60_000;

export const DEDUPE_WINDOW = DEDUPE_WINDOW_MS;

/** Identical form content hashes identically; any changed field produces a new hash. */
export function buildPayloadHash(customer: CustomerData): string {
  const normalized = [
    customer.name,
    customer.phone.replace(/[\s\-()]/g, ""),
    customer.email,
    customer.company,
    customer.website ?? "",
    customer.team,
    customer.industry,
    customer.revenue,
    customer.businessProblem,
  ].map((value) => value.trim().toLowerCase());
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

export function buildDedupeKey(payloadHash: string, now: Date): string {
  return `${payloadHash}:${Math.floor(now.getTime() / DEDUPE_WINDOW_MS)}`;
}

export function generateSubmissionId(): string {
  return `FREE_${Date.now()}_${randomBytes(4).toString("hex")}`;
}

/** Persistence needed by the workflow; Mongo-backed in production, in-memory in tests. */
export interface FreeSubmissionStore {
  /**
   * Returns the record for identical content submitted within the last 24h (a retry),
   * otherwise creates a new one. Changed details are never merged into an old record.
   */
  upsert(customer: CustomerData, now: Date): Promise<FreeSubmissionDocument>;
  /** Zoho Lead ID recorded for an earlier submission by the same applicant, if any. */
  findLinkedLeadId(email: string, excludeSubmissionId: string): Promise<string | null>;
  get(submissionId: string): Promise<FreeSubmissionDocument | null>;
  claimZoho(submissionId: string, now: Date): Promise<FreeSubmissionDocument | null>;
  saveZohoSuccess(submissionId: string, leadId: string, now: Date): Promise<void>;
  saveZohoFailure(submissionId: string, errorCode: string): Promise<void>;
  claimEmail(submissionId: string, kind: FreeEmailKind, now: Date): Promise<boolean>;
  markEmailSent(submissionId: string, kind: FreeEmailKind, now: Date): Promise<void>;
  releaseEmail(submissionId: string, kind: FreeEmailKind): Promise<void>;
  findWithUnsentEmails(limit: number): Promise<FreeSubmissionDocument[]>;
}

export interface FreeSubmissionDependencies {
  store: FreeSubmissionStore;
  isZohoConfigured: () => boolean;
  pushLead: (input: PushFreePageLeadInput) => Promise<PushFreePageLeadResult>;
  sendApplicantEmail: (submission: FreeSubmissionDocument) => Promise<boolean>;
  sendTeamEmail: (submission: FreeSubmissionDocument) => Promise<boolean>;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
}

export type FreeSubmissionResult =
  | { ok: true; submissionId: string }
  | { ok: false; status: 503 | 502 | 409; error: "not_configured" | "crm_unavailable" | "in_progress" };

const EMAIL_FIELDS = {
  applicant: { claimedAt: "applicantEmailClaimedAt", sentAt: "applicantEmailSentAt" },
  team: { claimedAt: "teamEmailClaimedAt", sentAt: "teamEmailSentAt" },
} as const;

/** Sends any email not yet confirmed sent. Never throws; failures stay recoverable. */
export async function deliverFreeEmails(
  submissionId: string,
  deps: FreeSubmissionDependencies
): Promise<void> {
  const kinds: [FreeEmailKind, (s: FreeSubmissionDocument) => Promise<boolean>][] = [
    ["applicant", deps.sendApplicantEmail],
    ["team", deps.sendTeamEmail],
  ];
  await Promise.all(
    kinds.map(async ([kind, send]) => {
      try {
        if (!(await deps.store.claimEmail(submissionId, kind, deps.now()))) return;
        const submission = await deps.store.get(submissionId);
        const sent = submission ? await send(submission) : false;
        if (!sent) {
          await deps.store.releaseEmail(submissionId, kind);
          return;
        }
        // If this write fails the claim expires and the email is retried; Resend's idempotency
        // key (per submission and kind) stops that retry from sending a second copy.
        await deps.store.markEmailSent(submissionId, kind, deps.now());
      } catch (error) {
        await deps.store.releaseEmail(submissionId, kind).catch(() => undefined);
        console.error("[FREE_SUBMISSION] Email step failed.", {
          submissionId,
          kind,
          errorClass: getSafeCheckoutErrorClass(error),
        });
      }
    })
  );
}

/**
 * Saves a free-page submission: record -> Zoho Lead -> emails. Success is only
 * reported once Zoho has confirmed the Lead, and emails are only sent after that.
 * Safe to call repeatedly for the same applicant: it reuses the stored record and
 * Lead ID, so a retry after any partial failure never creates a second Lead.
 */
export async function processFreeSubmission(
  customer: CustomerData,
  deps: FreeSubmissionDependencies
): Promise<FreeSubmissionResult> {
  if (!deps.isZohoConfigured()) return { ok: false, status: 503, error: "not_configured" };

  let record = await deps.store.upsert(customer, deps.now());
  const { submissionId } = record;

  if (!record.zoho?.leadId) {
    let claimed = await deps.store.claimZoho(submissionId, deps.now());
    // A concurrent request (e.g. a double click) holds the lease: wait for its result.
    for (let attempt = 0; !claimed && attempt < 3; attempt++) {
      await deps.sleep(1_500);
      const latest = await deps.store.get(submissionId);
      if (latest?.zoho?.leadId) {
        record = latest;
        break;
      }
      claimed = await deps.store.claimZoho(submissionId, deps.now());
    }

    if (!record.zoho?.leadId) {
      if (!claimed) return { ok: false, status: 409, error: "in_progress" };
      let leadId: string;
      try {
        leadId = (
          await deps.pushLead({
            customer: claimed.customer,
            submissionRef: submissionId,
            knownLeadId: claimed.zoho?.leadId,
            linkedLeadId:
              (await deps.store.findLinkedLeadId(claimed.customer.email, submissionId)) ?? undefined,
          })
        ).leadId;
      } catch (error) {
        const code = error instanceof ZohoError ? error.code : "UNEXPECTED_ERROR";
        await deps.store.saveZohoFailure(submissionId, code).catch(() => undefined);
        console.warn("[FREE_SUBMISSION] Zoho Lead was not created.", { submissionId, code });
        return { ok: false, status: 502, error: "crm_unavailable" };
      }

      // Zoho has confirmed the Lead. Record its ID. If MongoDB is failing, the details are
      // already safe in the CRM, so do not report a failure; a later submission finds the same
      // Lead (stored ID or Zoho's email duplicate check) and records it then.
      const recorded = await recordLeadId(deps, submissionId, leadId);
      if (!recorded) {
        console.error("[FREE_SUBMISSION] CRM_CONFIRMED_BUT_NOT_RECORDED", { submissionId, leadId });
        return { ok: true, submissionId };
      }
    }
  }

  await deliverFreeEmails(submissionId, deps);
  return { ok: true, submissionId };
}

async function recordLeadId(
  deps: FreeSubmissionDependencies,
  submissionId: string,
  leadId: string
): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await deps.store.saveZohoSuccess(submissionId, leadId, deps.now());
      return true;
    } catch {
      if (attempt < 2) await deps.sleep(300 * (attempt + 1));
    }
  }
  return false;
}

/** Retries emails that were never confirmed sent, for Leads Zoho already holds. */
export async function retryFreeEmails(
  deps: FreeSubmissionDependencies,
  limit = 20
): Promise<{ processed: number }> {
  const due = await deps.store.findWithUnsentEmails(limit);
  for (const submission of due) await deliverFreeEmails(submission.submissionId, deps);
  return { processed: due.length };
}

// ---- Mongo implementation -------------------------------------------------

let indexesEnsured = false;

async function getCollection(): Promise<Collection<FreeSubmissionDocument>> {
  const col = (await getDb()).collection<FreeSubmissionDocument>(FREE_COLLECTION);
  if (!indexesEnsured) {
    await col.createIndex({ submissionId: 1 }, { unique: true, name: "uniq_submission_id" });
    await col.createIndex({ dedupeKey: 1 }, { unique: true, name: "uniq_dedupe_key" });
    await col.createIndex({ payloadHash: 1, createdAt: -1 }, { name: "idx_payload_recent" });
    await col.createIndex({ "customer.email": 1, createdAt: -1 }, { name: "idx_free_email" });
    indexesEnsured = true;
  }
  return col;
}

/**
 * Zoho Lead ID of the latest free submission with this email. Best effort: it lets the
 * paid workflow reuse a Lead that Zoho search cannot see yet, and a failure returns null.
 */
export async function findFreeSubmissionLeadIdForEmail(
  email: string,
  excludeSubmissionId = ""
): Promise<string | null> {
  if (!isMongoConfigured()) return null;
  try {
    const linked = await (await getDb())
      .collection<FreeSubmissionDocument>(FREE_COLLECTION)
      .findOne(
        { "customer.email": email, submissionId: { $ne: excludeSubmissionId }, "zoho.leadId": { $exists: true } },
        { sort: { createdAt: -1 } }
      );
    return linked?.zoho?.leadId ?? null;
  } catch {
    return null;
  }
}

/** Lead ID recorded for this email by a paid-page order. Best effort; a failure returns null. */
async function findPaidOrderLeadIdForEmail(email: string): Promise<string | null> {
  try {
    return await findZohoLeadIdForEmail(email, "");
  } catch {
    return null;
  }
}

export function createMongoFreeStore(): FreeSubmissionStore {
  return {
    async upsert(customer, now) {
      const col = await getCollection();
      const payloadHash = buildPayloadHash(customer);
      const dedupeKey = buildDedupeKey(payloadHash, now);
      const recent = await col.findOne({
        payloadHash,
        createdAt: { $gte: new Date(now.getTime() - DEDUPE_WINDOW_MS) },
      });
      if (recent) return recent;
      const doc: FreeSubmissionDocument = {
        submissionId: generateSubmissionId(),
        payloadHash,
        dedupeKey,
        customer,
        zoho: { attempts: 0 },
        createdAt: now,
        updatedAt: now,
      };
      try {
        await col.insertOne(doc);
        return doc;
      } catch (error) {
        // Lost a race with a concurrent identical submission: use the winner.
        const winner = await col.findOne({ dedupeKey });
        if (winner) return winner;
        throw error;
      }
    },
    async findLinkedLeadId(email, excludeSubmissionId) {
      const col = await getCollection();
      const linked = await col.findOne(
        {
          "customer.email": email,
          submissionId: { $ne: excludeSubmissionId },
          "zoho.leadId": { $exists: true },
        },
        { sort: { createdAt: -1 } }
      );
      // Fall back to a paid-page order's Lead: Zoho search lags new Leads by about a minute,
      // and without the ID the Email upsert would overwrite that Lead's Lead Source.
      return linked?.zoho?.leadId ?? (await findPaidOrderLeadIdForEmail(email));
    },
    async get(submissionId) {
      return (await getCollection()).findOne({ submissionId });
    },
    async claimZoho(submissionId, now) {
      const col = await getCollection();
      return col.findOneAndUpdate(
        {
          submissionId,
          "zoho.leadId": { $exists: false },
          $or: [{ "zoho.lockedUntil": null }, { "zoho.lockedUntil": { $lt: now } }],
        },
        { $set: { "zoho.lockedUntil": new Date(now.getTime() + ZOHO_LEASE_MS) }, $inc: { "zoho.attempts": 1 } },
        { returnDocument: "after" }
      );
    },
    async saveZohoSuccess(submissionId, leadId, now) {
      const col = await getCollection();
      await col.updateOne(
        { submissionId },
        {
          $set: { "zoho.leadId": leadId, "zoho.syncedAt": now, updatedAt: now },
          $unset: { "zoho.lockedUntil": "", "zoho.lastError": "" },
        }
      );
    },
    async saveZohoFailure(submissionId, errorCode) {
      const col = await getCollection();
      await col.updateOne(
        { submissionId },
        { $set: { "zoho.lastError": errorCode, updatedAt: new Date() }, $unset: { "zoho.lockedUntil": "" } }
      );
    },
    async claimEmail(submissionId, kind, now) {
      const col = await getCollection();
      const { claimedAt, sentAt } = EMAIL_FIELDS[kind];
      const cutoff = new Date(now.getTime() - EMAIL_LEASE_MS);
      const claimed = await col.findOneAndUpdate(
        {
          submissionId,
          "zoho.leadId": { $exists: true },
          [sentAt]: null,
          $or: [{ [claimedAt]: null }, { [claimedAt]: { $lt: cutoff } }],
        },
        { $set: { [claimedAt]: now } }
      );
      return Boolean(claimed);
    },
    async markEmailSent(submissionId, kind, now) {
      const { sentAt } = EMAIL_FIELDS[kind];
      await (await getCollection()).updateOne({ submissionId }, { $set: { [sentAt]: now } });
    },
    async releaseEmail(submissionId, kind) {
      const { claimedAt, sentAt } = EMAIL_FIELDS[kind];
      await (await getCollection()).updateOne({ submissionId, [sentAt]: null }, { $unset: { [claimedAt]: "" } });
    },
    async findWithUnsentEmails(limit) {
      const col = await getCollection();
      return col
        .find({
          "zoho.leadId": { $exists: true },
          $or: [{ applicantEmailSentAt: { $exists: false } }, { teamEmailSentAt: { $exists: false } }],
        })
        .sort({ createdAt: 1 })
        .limit(limit)
        .toArray();
    },
  };
}

export function createDefaultFreeDependencies(): FreeSubmissionDependencies {
  return {
    store: createMongoFreeStore(),
    isZohoConfigured,
    pushLead: pushFreePageLeadToZoho,
    sendApplicantEmail: sendFreeApplicantConfirmationEmail,
    sendTeamEmail: sendFreeTeamNotificationEmail,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => new Date(),
  };
}
