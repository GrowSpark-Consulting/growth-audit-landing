import {
  FIXED_ORDER_AMOUNT,
  FIXED_ORDER_CURRENCY,
  FIXED_PRODUCT_NAME,
  type OrderDocument,
  type PayUDetails,
} from "./orders";
import type { PayUConfig, PayUResponseData } from "./payu";

export type PayUCallbackError =
  | "missing_transaction"
  | "invalid_merchant"
  | "hash_mismatch"
  | "order_not_found"
  | "amount_mismatch"
  | "transaction_mismatch"
  | "invalid_status"
  | "processing_error";

export type PayUCallbackResult =
  | { ok: true; txnid: string; status: "PAID" | "FAILED"; token: string }
  | { ok: false; error: PayUCallbackError; txnid?: string };

export interface PayUCallbackDependencies {
  config: PayUConfig;
  findOrderByTxnid: (txnid: string) => Promise<OrderDocument | null>;
  updateOrderStatus: (
    txnid: string,
    status: "PAID" | "FAILED",
    details: PayUDetails
  ) => Promise<{ success: boolean; order: OrderDocument | null }>;
  verifyHash: (data: PayUResponseData, salt: string) => boolean;
  createToken: (txnid: string, status: string, amount: number) => string;
}

function amountMatches(received: string, expected: number): boolean {
  if (!/^\d+(?:\.\d{1,2})?$/.test(received)) return false;
  const parsed = Number(received);
  return Number.isFinite(parsed) && Math.round(parsed * 100) === Math.round(expected * 100);
}

function getPersistedPaymentStatus(
  order: OrderDocument
): "PAID" | "FAILED" | null {
  if (!(order.payu?.verifiedAt instanceof Date)) return null;
  const payuStatus = order.payu.status?.toLowerCase();
  if (order.status === "PAID" && payuStatus === "success") return "PAID";
  if (order.status === "FAILED" && ["failure", "failed"].includes(payuStatus ?? "")) {
    return "FAILED";
  }
  return null;
}

/** Validates a signed PayU callback, applies its terminal state, and signs only
 * the latest verified state read back from the database. */
export async function processPayUCallback(
  data: PayUResponseData,
  dependencies: PayUCallbackDependencies
): Promise<PayUCallbackResult> {
  const txnid = typeof data.txnid === "string" ? data.txnid : "";
  if (!txnid) return { ok: false, error: "missing_transaction" };

  const { config } = dependencies;
  if (!config.key || !config.salt || data.key !== config.key) {
    return { ok: false, error: "invalid_merchant", txnid };
  }
  if (!dependencies.verifyHash(data, config.salt)) {
    return { ok: false, error: "hash_mismatch", txnid };
  }

  const callbackStatus = typeof data.status === "string" ? data.status.toLowerCase() : "";
  const targetStatus = callbackStatus === "success"
    ? "PAID"
    : ["failure", "failed"].includes(callbackStatus)
      ? "FAILED"
      : null;
  if (!targetStatus) return { ok: false, error: "invalid_status", txnid };

  try {
    const order = await dependencies.findOrderByTxnid(txnid);
    if (!order) return { ok: false, error: "order_not_found", txnid };
    if (
      order.txnid !== txnid ||
      order.productInfo !== FIXED_PRODUCT_NAME ||
      data.productinfo !== order.productInfo ||
      (typeof data.currency === "string" && data.currency !== order.currency) ||
      (typeof data.email === "string" &&
        data.email.toLowerCase() !== order.customer.email.toLowerCase()) ||
      (typeof data.firstname === "string" &&
        data.firstname !==
          (order.customer.name.trim().split(/\s+/)[0]?.slice(0, 50) || "Customer")) ||
      order.amount !== FIXED_ORDER_AMOUNT ||
      order.currency !== FIXED_ORDER_CURRENCY
    ) {
      return { ok: false, error: "transaction_mismatch", txnid };
    }
    if (!amountMatches(data.amount ?? "", order.amount)) {
      return { ok: false, error: "amount_mismatch", txnid };
    }

    const details: PayUDetails = {
      mihpayid: typeof data.mihpayid === "string" ? data.mihpayid : undefined,
      mode: typeof data.mode === "string" ? data.mode : undefined,
      status: typeof data.status === "string" ? data.status : undefined,
      unmappedstatus:
        typeof data.unmappedstatus === "string" ? data.unmappedstatus : undefined,
      bankRefNum:
        typeof data.bank_ref_num === "string" ? data.bank_ref_num : undefined,
      bankcode: typeof data.bankcode === "string" ? data.bankcode : undefined,
      error: typeof data.error === "string" ? data.error : undefined,
      errorMessage:
        typeof data.error_Message === "string"
          ? data.error_Message
          : typeof data.errorMessage === "string"
            ? data.errorMessage
            : undefined,
      additionalCharges:
        typeof data.additionalCharges === "string"
          ? data.additionalCharges
          : typeof data.additional_charges === "string"
            ? data.additional_charges
            : undefined,
      rawResponseHash: typeof data.hash === "string" ? data.hash : undefined,
    };

    const update = await dependencies.updateOrderStatus(txnid, targetStatus, details);
    if (!update.success || !update.order || update.order.txnid !== txnid) {
      return { ok: false, error: "processing_error", txnid };
    }

    // Read back after the atomic transition so duplicate or concurrent callbacks
    // use the persisted winner, never the callback's requested state.
    const persisted = await dependencies.findOrderByTxnid(txnid);
    if (!persisted) return { ok: false, error: "order_not_found", txnid };
    if (
      persisted.txnid !== txnid ||
      persisted.amount !== order.amount ||
      persisted.currency !== order.currency
    ) {
      return { ok: false, error: "transaction_mismatch", txnid };
    }

    const persistedStatus = getPersistedPaymentStatus(persisted);
    if (!persistedStatus) return { ok: false, error: "processing_error", txnid };
    const token = dependencies.createToken(txnid, persistedStatus, persisted.amount);
    if (!token) return { ok: false, error: "processing_error", txnid };

    return {
      ok: true,
      txnid,
      status: persistedStatus,
      token,
    };
  } catch {
    return { ok: false, error: "processing_error", txnid };
  }
}
