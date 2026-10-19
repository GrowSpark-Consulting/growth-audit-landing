import { NextRequest, NextResponse } from "next/server";
import { isMongoConfigured } from "@/lib/db";
import { createDefaultFreeDependencies, retryFreeEmails } from "@/lib/free-submissions";
import { isAuthorizedCronRequest } from "@/lib/payment-email-recovery";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Daily Vercel Cron: re-sends free-page emails that were never confirmed sent. */
export async function GET(request: NextRequest) {
  if (!isAuthorizedCronRequest(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return new NextResponse("Unauthorized", { status: 401 });
  }
  if (!isMongoConfigured()) {
    return NextResponse.json({ error: "not_configured" }, { status: 503 });
  }
  try {
    const summary = await retryFreeEmails(createDefaultFreeDependencies());
    console.info("[FREE_EMAIL_RECOVERY]", summary);
    return NextResponse.json(summary);
  } catch {
    console.error("[FREE_EMAIL_RECOVERY] Recovery run failed.");
    return NextResponse.json({ error: "recovery_failed" }, { status: 500 });
  }
}
