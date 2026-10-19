import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import {
  FIXED_ORDER_AMOUNT,
  FIXED_ORDER_CURRENCY,
  FIXED_PRODUCT_NAME,
  type OrderDocument,
} from "../src/lib/orders";
import {
  sendCustomerPaymentConfirmationEmail,
  sendTeamPaymentNotificationEmail,
} from "../src/lib/email";

const order: OrderDocument = {
  txnid: "GSA_TEST_001",
  amount: FIXED_ORDER_AMOUNT,
  currency: FIXED_ORDER_CURRENCY,
  productInfo: FIXED_PRODUCT_NAME,
  customer: {
    name: "Test <b>Customer</b>",
    phone: "9876543210",
    email: "customer@example.com",
    company: "Example & Co",
    team: "1-5",
    industry: "Technology & software",
    revenue: "Below ₹50 lakh",
    businessProblem: "Another business challenge",
  },
  status: "PAID",
  createdAt: new Date(),
  updatedAt: new Date(),
};

const realFetch = globalThis.fetch;
const realKey = process.env.RESEND_API_KEY;
let requests: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];

function stubFetch(respond: () => Response | Promise<Response>) {
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({
      url: String(url),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)),
    });
    return respond();
  }) as typeof fetch;
}

beforeEach(() => {
  requests = [];
  process.env.RESEND_API_KEY = "re_test_key";
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (realKey === undefined) delete process.env.RESEND_API_KEY;
  else process.env.RESEND_API_KEY = realKey;
});

test("customer email uses the verified sender, one recipient and an idempotency key", async () => {
  stubFetch(() => Response.json({ id: "email_1" }));
  assert.equal(await sendCustomerPaymentConfirmationEmail(order), true);

  assert.equal(requests.length, 1);
  const [request] = requests;
  assert.equal(new URL(request.url).pathname, "/emails");
  assert.equal(request.headers.get("Idempotency-Key"), "payment-confirmation/customer/GSA_TEST_001");
  assert.equal(request.body.from, "GrowSpark Consulting <noreply@growsparkconsulting.com>");
  assert.deepEqual(request.body.to, "customer@example.com");
  assert.match(String(request.body.html), /GSA_TEST_001/);
  assert.match(String(request.body.html), /₹999/);
  // Customer-supplied markup is escaped, never injected.
  assert.doesNotMatch(String(request.body.html), /<b>Customer<\/b>/);
});

test("team email goes to all three team addresses with its own idempotency key", async () => {
  stubFetch(() => Response.json({ id: "email_2" }));
  assert.equal(await sendTeamPaymentNotificationEmail(order), true);

  const [request] = requests;
  assert.equal(request.headers.get("Idempotency-Key"), "payment-confirmation/team/GSA_TEST_001");
  assert.deepEqual(request.body.to, [
    "raja@growsparkconsulting.com",
    "pragadeesh@growsparkconsulting.com",
    "susshinder@growsparkconsulting.com",
  ]);
  for (const value of ["9876543210", "customer@example.com", "Another business challenge"]) {
    assert.ok(String(request.body.text).includes(value), `team email text includes ${value}`);
  }
});

test("a retry sends the same payload and key, as Resend idempotency requires", async () => {
  stubFetch(() => Response.json({ id: "email_3" }));
  await sendCustomerPaymentConfirmationEmail(order);
  await sendCustomerPaymentConfirmationEmail(order);
  assert.equal(requests[0].headers.get("Idempotency-Key"), requests[1].headers.get("Idempotency-Key"));
  assert.deepEqual(requests[0].body, requests[1].body);
});

test("Resend API errors, including 409 idempotency conflicts, return false without throwing", async () => {
  stubFetch(() =>
    Response.json(
      { name: "concurrent_idempotent_requests", message: "in progress", statusCode: 409 },
      { status: 409 }
    )
  );
  assert.equal(await sendCustomerPaymentConfirmationEmail(order), false);
  assert.equal(await sendTeamPaymentNotificationEmail(order), false);
});

test("network failures return false without throwing", async () => {
  stubFetch(() => {
    throw new Error("network down");
  });
  assert.equal(await sendCustomerPaymentConfirmationEmail(order), false);
});
