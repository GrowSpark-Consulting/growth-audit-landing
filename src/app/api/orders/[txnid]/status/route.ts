import { NextRequest, NextResponse } from "next/server";
import { findOrderByTxnid } from "@/lib/orders";
import { verifyOrderVerificationToken } from "@/lib/payu";

export const runtime = "nodejs";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ txnid: string }> }
) {
  try {
    const { txnid } = await context.params;
    const token = request.nextUrl.searchParams.get("token") || "";

    if (!txnid) {
      return NextResponse.json(
        { ok: false, error: "Transaction ID is required." },
        { status: 400 }
      );
    }

    const order = await findOrderByTxnid(txnid);
    if (!order) {
      return NextResponse.json(
        { ok: false, error: "Order not found." },
        { status: 404 }
      );
    }

    // Security check: require a valid HMAC verification token
    const isTokenValid = verifyOrderVerificationToken(
      order.txnid,
      order.status,
      order.amount,
      token
    );

    if (!isTokenValid) {
      return NextResponse.json(
        {
          ok: false,
          error: "Access denied. Valid verification token required to view order status.",
        },
        { status: 403 }
      );
    }

    // Return only safe, non-sensitive public metadata
    return NextResponse.json({
      ok: true,
      txnid: order.txnid,
      status: order.status,
      amount: order.amount,
      currency: order.currency,
      productName: order.productInfo,
      customer: {
        name: order.customer.name,
        company: order.customer.company,
      },
      confirmedAt: order.payu?.verifiedAt || order.updatedAt || order.createdAt,
    });
  } catch {
    console.error("[ORDER_STATUS] Unable to retrieve order status.");
    return NextResponse.json(
      { ok: false, error: "Unable to retrieve order status." },
      { status: 500 }
    );
  }
}
