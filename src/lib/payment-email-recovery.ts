import { createHash, timingSafeEqual } from "crypto";
import type { OrderDocument } from "./orders";
import { sendPaymentEmails, type PaymentEmails } from "./payu-callback";

export const RECOVERY_MIN_ORDER_AGE_MS = 5 * 60 * 1000;
export const RECOVERY_MAX_ORDER_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const RECOVERY_BATCH_LIMIT = 10;
/** Stop starting new orders after this long, leaving headroom under maxDuration. */
export const RECOVERY_TIME_BUDGET_MS = 40 * 1000;

export interface RecoverySummary {
  scanned: number;
  customerSent: number;
  teamSent: number;
  failed: number;
  skippedForTime: number;
}

/** Fails closed: a missing or short secret authorizes nothing. */
export function isAuthorizedCronRequest(
  authorization: string | null,
  secret: string | undefined
): boolean {
  if (!secret || secret.length < 16 || !authorization) return false;
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(authorization), digest(`Bearer ${secret}`));
}

/**
 * Parses PAYMENT_EMAIL_RECOVERY_START (an ISO timestamp, set to the go-live time).
 * Returns null when missing or invalid, so the cron refuses to run rather than
 * emailing orders that predate email support.
 */
export function parseRecoveryStart(raw: string | undefined): Date | null {
  if (!raw?.trim()) return null;
  const parsed = new Date(raw.trim());
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export interface RecoveryDependencies {
  findCandidates: (options: {
    now: Date;
    minAgeMs: number;
    maxAgeMs: number;
    notBefore: Date;
    limit: number;
  }) => Promise<OrderDocument[]>;
  /** Go-live time; older orders are never retried. */
  notBefore: Date;
  emails: PaymentEmails;
  now?: () => Date;
  clock?: () => number;
}

/**
 * Retries unsent payment emails for recently paid orders. Reuses the callback's
 * claim / lease / idempotency path, so it cannot duplicate a send that a live
 * callback or another run holds. Logs transaction ids only, never customer data.
 */
export async function retryPendingPaymentEmails(
  dependencies: RecoveryDependencies
): Promise<RecoverySummary> {
  const clock = dependencies.clock ?? Date.now;
  const startedAt = clock();
  const summary: RecoverySummary = {
    scanned: 0,
    customerSent: 0,
    teamSent: 0,
    failed: 0,
    skippedForTime: 0,
  };

  const orders = await dependencies.findCandidates({
    now: dependencies.now?.() ?? new Date(),
    minAgeMs: RECOVERY_MIN_ORDER_AGE_MS,
    maxAgeMs: RECOVERY_MAX_ORDER_AGE_MS,
    notBefore: dependencies.notBefore,
    limit: RECOVERY_BATCH_LIMIT,
  });
  summary.scanned = orders.length;

  for (const order of orders) {
    if (clock() - startedAt > RECOVERY_TIME_BUDGET_MS) {
      summary.skippedForTime += 1;
      continue;
    }
    const outcome = await sendPaymentEmails(order, dependencies.emails);
    if (outcome.customer === "sent") summary.customerSent += 1;
    if (outcome.team === "sent") summary.teamSent += 1;
    if (outcome.customer === "failed" || outcome.team === "failed") {
      summary.failed += 1;
      console.error(
        `[EMAIL_RECOVERY] Retry failed for ${order.txnid} (customer: ${outcome.customer}, team: ${outcome.team}).`
      );
    }
  }
  return summary;
}
