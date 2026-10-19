import { NextRequest, NextResponse } from "next/server";
import { getSafeCheckoutErrorClass } from "@/lib/checkout-diagnostics";
import { isMongoConfigured } from "@/lib/db";
import { createDefaultFreeDependencies, processFreeSubmission } from "@/lib/free-submissions";
import { validateCustomerInput } from "@/lib/orders";
import { createRateLimiter } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const maxDuration = 30;

// Best effort per server instance; the dedupe record is what guarantees idempotency.
const limiter = createRateLimiter({ limit: 8, windowMs: 10 * 60_000 });

const ERROR_MESSAGES = {
  not_configured: "This form is temporarily unavailable. Please try again later.",
  crm_unavailable: "We could not save your request. Please try again in a moment.",
  in_progress: "Your request is already being processed. Please wait a moment and try again.",
} as const;

/** Free workflow only: never creates an order or touches the payment gateway. */
export async function POST(request: NextRequest) {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if (!limiter.take(ip)) {
    return NextResponse.json(
      { ok: false, error: "Too many requests. Please try again later." },
      { status: 429 }
    );
  }

  try {
    const body = await request.json().catch(() => null);
    const validation = validateCustomerInput(body ?? {});
    if (!validation.valid || !validation.data) {
      return NextResponse.json({ ok: false, errors: validation.errors }, { status: 400 });
    }
    if (!isMongoConfigured()) {
      return NextResponse.json({ ok: false, error: ERROR_MESSAGES.not_configured }, { status: 503 });
    }

    const result = await processFreeSubmission(validation.data, createDefaultFreeDependencies());
    if (!result.ok) {
      return NextResponse.json({ ok: false, error: ERROR_MESSAGES[result.error] }, { status: result.status });
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("[FREE_SUBMIT] Submission failed.", { errorClass: getSafeCheckoutErrorClass(error) });
    return NextResponse.json(
      { ok: false, error: ERROR_MESSAGES.crm_unavailable },
      { status: 500 }
    );
  }
}
