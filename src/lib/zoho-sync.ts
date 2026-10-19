import { getSafeCheckoutErrorClass } from "./checkout-diagnostics";
import {
  claimOrderForZohoSync,
  findOrdersDueForZohoSync,
  findZohoLeadIdForEmail,
  releaseZohoSyncClaim,
  saveZohoSyncResult,
  type OrderDocument,
  type ZohoSyncUpdate,
} from "./orders";
import {
  isZohoConfigured,
  LEAD_SOURCE_FREE,
  LEAD_SOURCE_PAID,
  pushLeadToZoho,
  ZohoError,
  type PushLeadInput,
  type PushLeadResult,
  type ZohoLeadSource,
} from "./zoho";

export const ZOHO_MAX_ATTEMPTS = 10;

export interface ZohoSyncDependencies {
  isConfigured: () => boolean;
  claimOrder: (txnid: string) => Promise<OrderDocument | null>;
  releaseClaim: (txnid: string) => Promise<void>;
  saveResult: (txnid: string, update: ZohoSyncUpdate) => Promise<boolean>;
  findDue: (limit: number, now: Date) => Promise<string[]>;
  findLinkedLead: (email: string, excludeTxnid: string) => Promise<string | null>;
  pushLead: (input: PushLeadInput) => Promise<PushLeadResult>;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
}

export const defaultZohoSyncDependencies: ZohoSyncDependencies = {
  isConfigured: isZohoConfigured,
  claimOrder: (txnid) => claimOrderForZohoSync(txnid),
  releaseClaim: releaseZohoSyncClaim,
  saveResult: (txnid, update) => saveZohoSyncResult(txnid, update),
  findDue: findOrdersDueForZohoSync,
  findLinkedLead: findZohoLeadIdForEmail,
  pushLead: pushLeadToZoho,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => new Date(),
};

export type ZohoSyncOutcome =
  | { result: "synced" | "already_synced"; leadId: string; leadSource: ZohoLeadSource }
  | { result: "retry_required" | "failed"; error: string }
  | { result: "skipped"; reason: "not_configured" | "locked_or_missing" };

export interface ZohoSyncOptions {
  /** Extra lease attempts, for callers that should wait out a concurrent sync. */
  lockRetries?: number;
  lockRetryDelayMs?: number;
}

export function nextRetryDelayMs(attempts: number): number {
  return Math.min(60_000 * 2 ** Math.max(attempts - 1, 0), 6 * 60 * 60_000);
}

let notConfiguredLogged = false;

/**
 * Brings the Zoho Lead for one submission in line with its payment state:
 * unpaid or failed orders map to "Growth Audit Free", verified PAID orders to
 * "Growth Audit Paid". Safe to call repeatedly; it never creates a second Lead.
 */
export async function syncOrderToZoho(
  txnid: string,
  options: ZohoSyncOptions = {},
  deps: ZohoSyncDependencies = defaultZohoSyncDependencies
): Promise<ZohoSyncOutcome> {
  if (!deps.isConfigured()) {
    if (!notConfiguredLogged) {
      notConfiguredLogged = true;
      console.warn("[ZOHO_SYNC] Zoho CRM is not configured; submissions stay queued as PENDING.");
    }
    return { result: "skipped", reason: "not_configured" };
  }

  let order = await deps.claimOrder(txnid);
  for (let attempt = 0; !order && attempt < (options.lockRetries ?? 0); attempt++) {
    await deps.sleep(options.lockRetryDelayMs ?? 2_000);
    order = await deps.claimOrder(txnid);
  }
  if (!order) return { result: "skipped", reason: "locked_or_missing" };

  // The order status is only set to PAID by the server-verified PayU callback.
  const target: ZohoLeadSource = order.status === "PAID" ? LEAD_SOURCE_PAID : LEAD_SOURCE_FREE;
  const state = order.zoho;
  if (
    state?.status === "SYNCED" &&
    state.leadId &&
    (state.leadSource === LEAD_SOURCE_PAID || target === LEAD_SOURCE_FREE)
  ) {
    await deps.releaseClaim(txnid);
    return { result: "already_synced", leadId: state.leadId, leadSource: state.leadSource ?? target };
  }

  let pushed: PushLeadResult;
  try {
    const linkedLeadId = state?.leadId
      ? undefined
      : (await deps.findLinkedLead(order.customer.email, order.txnid)) ?? undefined;
    pushed = await deps.pushLead({
      customer: order.customer,
      target,
      submissionRef: order.txnid,
      known: { leadId: state?.leadId, leadSource: state?.leadSource },
      linkedLeadId,
      payment:
        target === LEAD_SOURCE_PAID
          ? { amount: order.amount, currency: order.currency, payuId: order.payu?.mihpayid }
          : undefined,
    });
  } catch (error) {
    const zohoError = error instanceof ZohoError ? error : new ZohoError("UNEXPECTED_ERROR", true);
    const attempts = (state?.attempts ?? 0) + 1;
    const giveUp = !zohoError.retryable || attempts >= ZOHO_MAX_ATTEMPTS;
    await deps.saveResult(txnid, {
      status: giveUp ? "FAILED" : "RETRY_REQUIRED",
      error: zohoError.code,
      nextRetryAt: giveUp ? undefined : new Date(deps.now().getTime() + nextRetryDelayMs(attempts)),
      countAttempt: true,
    });
    console.warn("[ZOHO_SYNC] Lead sync failed.", {
      txnid,
      stage: target === LEAD_SOURCE_PAID ? "paid" : "free",
      code: zohoError.code,
      attempts,
      willRetry: !giveUp,
    });
    return { result: giveUp ? "failed" : "retry_required", error: zohoError.code };
  }

  const synced: ZohoSyncUpdate = {
    status: "SYNCED",
    leadId: pushed.leadId,
    leadSource: pushed.leadSource,
    countAttempt: true,
  };
  if (pushed.leadSource === LEAD_SOURCE_FREE) {
    const saved = await deps.saveResult(txnid, { ...synced, onlyIfNotPaid: true });
    if (!saved) {
      // Payment was verified while this sync ran; queue the upgrade to Paid.
      await deps.saveResult(txnid, {
        ...synced,
        status: "RETRY_REQUIRED",
        nextRetryAt: deps.now(),
        countAttempt: false,
      });
      return { result: "retry_required", error: "PAYMENT_CONFIRMED_DURING_SYNC" };
    }
  } else {
    await deps.saveResult(txnid, synced);
  }

  console.info("[ZOHO_SYNC] Lead synced.", { txnid, leadId: pushed.leadId, leadSource: pushed.leadSource });
  return { result: "synced", leadId: pushed.leadId, leadSource: pushed.leadSource };
}

/** Never throws; intended for `after()` callbacks where failures must not
 * affect the checkout or payment response. */
export async function syncOrderToZohoSafely(txnid: string, options?: ZohoSyncOptions): Promise<void> {
  try {
    await syncOrderToZoho(txnid, options);
  } catch (error) {
    console.error("[ZOHO_SYNC] Unexpected sync failure.", {
      txnid,
      errorClass: getSafeCheckoutErrorClass(error),
    });
  }
}

export interface ZohoRetrySummary {
  processed: number;
  synced: number;
  retryRequired: number;
  failed: number;
  skipped: number;
}

/** Retries due submissions one at a time to stay within Zoho API rate limits. */
export async function retryDueZohoSyncs(
  limit: number,
  deps: ZohoSyncDependencies = defaultZohoSyncDependencies
): Promise<ZohoRetrySummary> {
  const summary: ZohoRetrySummary = { processed: 0, synced: 0, retryRequired: 0, failed: 0, skipped: 0 };
  for (const txnid of await deps.findDue(limit, deps.now())) {
    const outcome = await syncOrderToZoho(txnid, {}, deps);
    summary.processed += 1;
    if (outcome.result === "synced" || outcome.result === "already_synced") summary.synced += 1;
    else if (outcome.result === "retry_required") summary.retryRequired += 1;
    else if (outcome.result === "failed") summary.failed += 1;
    else summary.skipped += 1;
  }
  return summary;
}
