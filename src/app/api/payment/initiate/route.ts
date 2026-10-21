import { after, NextRequest, NextResponse } from "next/server";
import { validateCustomerInput, createOrder } from "@/lib/orders";
import {
  buildPayUPaymentPayload,
  isPayUConfigured,
} from "@/lib/payu";
import { getSafeCheckoutErrorClass } from "@/lib/checkout-diagnostics";
import { readMetaTrackingContext } from "@/lib/meta-capi";
import { syncOrderToZohoSafely } from "@/lib/zoho-sync";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  let stage:
    | "request_parsing"
    | "request_validation"
    | "configuration"
    | "order_creation"
    | "payu_payload"
    | "response" = "request_parsing";

  try {
    const body = await request.json();
    stage = "request_validation";
    const validation = validateCustomerInput(body);
    if (!validation.valid || !validation.data) {
      return NextResponse.json(
        { ok: false, errors: validation.errors },
        { status: 400 }
      );
    }

    stage = "configuration";
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

    stage = "order_creation";
    // Null unless the visitor accepted marketing cookies; then the Purchase event can be sent server-side.
    const order = await createOrder(validation.data, readMetaTrackingContext(request.headers) ?? undefined);
    // The submission is persisted; the CRM Lead ("Growth Audit Free") is created
    // after the response so Zoho latency or outages never block checkout.
    after(() => syncOrderToZohoSafely(order.txnid));

    stage = "payu_payload";
    const checkout = buildPayUPaymentPayload({
      txnid: order.txnid,
      amount: order.amount,
      productinfo: order.productInfo,
      name: order.customer.name,
      email: order.customer.email,
      phone: order.customer.phone,
    });

    stage = "response";
    return NextResponse.json({
      ok: true,
      txnid: order.txnid,
      action: checkout.action,
      // PayU's hosted checkout form requires the merchant key and request
      // signature. The merchant salt is never returned to the client.
      params: checkout.params,
    });
  } catch (error: unknown) {
    console.error("[PAYMENT_INITIATE] Checkout preparation failed.", {
      stage,
      errorClass: getSafeCheckoutErrorClass(error),
    });
    return NextResponse.json(
      {
        ok: false,
        error: "Unable to initiate payment at this time. Please try again later.",
      },
      { status: 500 }
    );
  }
}
