import { NextRequest, NextResponse } from "next/server";
import { validateCustomerInput, createOrder } from "@/lib/orders";
import {
  buildPayUPaymentPayload,
  isPayUConfigured,
} from "@/lib/payu";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const validation = validateCustomerInput(body);
    if (!validation.valid || !validation.data) {
      return NextResponse.json(
        { ok: false, errors: validation.errors },
        { status: 400 }
      );
    }

    // Invalid or incomplete mode-specific configuration must never create an
    // order. Production mode only reads its dedicated production credentials.
    if (!isPayUConfigured()) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "PayU is not configured for the selected mode. Check the server environment configuration.",
        },
        { status: 503 }
      );
    }

    const order = await createOrder(validation.data);
    const checkout = buildPayUPaymentPayload({
      txnid: order.txnid,
      amount: order.amount,
      productinfo: order.productInfo,
      name: order.customer.name,
      email: order.customer.email,
      phone: order.customer.phone,
    });

    return NextResponse.json({
      ok: true,
      txnid: order.txnid,
      action: checkout.action,
      // PayU's hosted checkout form requires the merchant key and request
      // signature. The merchant salt is never returned to the client.
      params: checkout.params,
    });
  } catch {
    console.error("[PAYMENT_INITIATE] Unable to prepare checkout.");
    return NextResponse.json(
      {
        ok: false,
        error: "Unable to initiate payment at this time. Please try again later.",
      },
      { status: 500 }
    );
  }
}
