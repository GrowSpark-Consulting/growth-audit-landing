import { NextRequest, NextResponse } from "next/server";
import {
  claimPaymentEmail,
  findPaidOrdersWithUnsentEmails,
  markPaymentEmailSent,
  releasePaymentEmailClaim,
} from "@/lib/orders";
import {
  sendCustomerPaymentConfirmationEmail,
  sendTeamPaymentNotificationEmail,
} from "@/lib/email";
import {
  isAuthorizedCronRequest,
  parseRecoveryStart,
  retryPendingPaymentEmails,
} from "@/lib/payment-email-recovery";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Daily Vercel Cron: retries payment emails that were never confirmed sent. */
export async function GET(request: NextRequest) {
  if (!isAuthorizedCronRequest(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const notBefore = parseRecoveryStart(process.env.PAYMENT_EMAIL_RECOVERY_START);
  if (!notBefore) {
    console.error("[EMAIL_RECOVERY] PAYMENT_EMAIL_RECOVERY_START is missing or invalid; not running.");
    return NextResponse.json({ error: "recovery_not_configured" }, { status: 500 });
  }

  try {
    const summary = await retryPendingPaymentEmails({
      notBefore,
      findCandidates: findPaidOrdersWithUnsentEmails,
      emails: {
        claim: claimPaymentEmail,
        markSent: markPaymentEmailSent,
        release: releasePaymentEmailClaim,
        sendCustomer: sendCustomerPaymentConfirmationEmail,
        sendTeam: sendTeamPaymentNotificationEmail,
      },
    });
    console.log(`[EMAIL_RECOVERY] ${JSON.stringify(summary)}`);
    return NextResponse.json(summary);
  } catch {
    console.error("[EMAIL_RECOVERY] Recovery run failed.");
    return NextResponse.json({ error: "recovery_failed" }, { status: 500 });
  }
}
