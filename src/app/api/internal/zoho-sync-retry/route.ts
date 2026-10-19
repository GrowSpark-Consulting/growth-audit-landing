import { timingSafeEqual } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { getSafeCheckoutErrorClass } from "@/lib/checkout-diagnostics";
import { isMongoConfigured } from "@/lib/db";
import { isZohoConfigured } from "@/lib/zoho";
import { retryDueZohoSyncs } from "@/lib/zoho-sync";

export const runtime = "nodejs";
export const maxDuration = 60;

const BATCH_SIZE = 10;

function isAuthorized(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return false;
  const provided = Buffer.from(request.headers.get("authorization") ?? "", "utf8");
  const expected = Buffer.from(`Bearer ${secret}`, "utf8");
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

// Vercel Cron invokes GET with `Authorization: Bearer $CRON_SECRET`; POST
// supports external schedulers.
async function handle(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  }
  if (!isZohoConfigured() || !isMongoConfigured()) {
    return NextResponse.json({ ok: false, error: "CRM sync is not configured." }, { status: 503 });
  }

  try {
    const summary = await retryDueZohoSyncs(BATCH_SIZE);
    if (summary.processed > 0) console.info("[ZOHO_SYNC_RETRY] Retry run finished.", summary);
    return NextResponse.json({ ok: true, ...summary });
  } catch (error) {
    console.error("[ZOHO_SYNC_RETRY] Retry run failed.", {
      errorClass: getSafeCheckoutErrorClass(error),
    });
    return NextResponse.json({ ok: false, error: "Retry run failed." }, { status: 500 });
  }
}

export { handle as GET, handle as POST };
