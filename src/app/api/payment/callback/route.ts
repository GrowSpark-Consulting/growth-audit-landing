import { after, NextRequest, NextResponse } from "next/server";
import {
  claimPaymentEmail,
  findOrderByTxnid,
  markPaymentEmailSent,
  releasePaymentEmailClaim,
  updateOrderStatus,
} from "@/lib/orders";
import {
  sendCustomerPaymentConfirmationEmail,
  sendTeamPaymentNotificationEmail,
} from "@/lib/email";
import {
  getPayUCallbackBaseUrl,
  getPayUConfig,
  verifyPayUResponseHash,
  generateOrderVerificationToken,
  type PayUResponseData,
} from "@/lib/payu";
import { processPayUCallback } from "@/lib/payu-callback";
import { sendPurchaseConversionSafely } from "@/lib/meta-capi";
import { syncOrderToZohoSafely } from "@/lib/zoho-sync";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  let redirectBaseUrl = "https://growthaudit.growsparkconsulting.com";
  try {
    const payuConfig = getPayUConfig();
    redirectBaseUrl = getPayUCallbackBaseUrl(payuConfig.mode);
    const formData = await request.formData();
    const data: PayUResponseData = {};

    formData.forEach((value, key) => {
      if (typeof value === "string") {
        data[key] = value;
      }
    });

    const result = await processPayUCallback(data, {
      config: payuConfig,
      findOrderByTxnid,
      updateOrderStatus,
      verifyHash: verifyPayUResponseHash,
      createToken: generateOrderVerificationToken,
      paymentEmails: {
        claim: claimPaymentEmail,
        markSent: markPaymentEmailSent,
        release: releasePaymentEmailClaim,
        sendCustomer: sendCustomerPaymentConfirmationEmail,
        sendTeam: sendTeamPaymentNotificationEmail,
      },
    });

    const redirectUrl = new URL("/thank-you", redirectBaseUrl);
    if (result.txnid) redirectUrl.searchParams.set("txnid", result.txnid);
    if (!result.ok) {
      console.warn(`[PAYU_CALLBACK] Callback rejected: ${result.error}`);
      redirectUrl.searchParams.set("error", result.error);
    } else {
      redirectUrl.searchParams.set("token", result.token);
      redirectUrl.searchParams.set("status", result.status === "PAID" ? "success" : "failed");
      // Runs only for hash-verified callbacks. A verified PAID order upgrades the
      // Lead to "Growth Audit Paid"; repeated callbacks resolve to a no-op.
      const verifiedTxnid = result.txnid;
      after(() => syncOrderToZohoSafely(verifiedTxnid, { lockRetries: 3 }));
      // Server-side Purchase for a verified payment; sent at most once even if PayU repeats the callback.
      if (result.status === "PAID") after(() => sendPurchaseConversionSafely(verifiedTxnid));
    }

    return NextResponse.redirect(redirectUrl, 303);
  } catch {
    console.error("[PAYU_CALLBACK] Internal processing error.");
    return NextResponse.redirect(
      new URL("/thank-you?error=processing_error", redirectBaseUrl),
      303
    );
  }
}

export async function GET() {
  // If visited via GET, safely redirect back to home page
  try {
    const config = getPayUConfig();
    return NextResponse.redirect(
      new URL("/", getPayUCallbackBaseUrl(config.mode)),
      307
    );
  } catch {
    return NextResponse.redirect(
      new URL("/", "https://growthaudit.growsparkconsulting.com"),
      307
    );
  }
}
