import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import { NextRequest } from "next/server";
import {
  FIXED_ORDER_AMOUNT,
  FIXED_ORDER_CURRENCY,
  FIXED_PRODUCT_NAME,
  type OrderDocument,
} from "../src/lib/orders";
import {
  RECOVERY_BATCH_LIMIT,
  RECOVERY_MAX_ORDER_AGE_MS,
  RECOVERY_MIN_ORDER_AGE_MS,
  RECOVERY_TIME_BUDGET_MS,
  isAuthorizedCronRequest,
  parseRecoveryStart,
  retryPendingPaymentEmails,
  type RecoveryDependencies,
} from "../src/lib/payment-email-recovery";
import { GET } from "../src/app/api/cron/retry-payment-emails/route";

const SECRET = "a-long-random-cron-secret-123";
const GO_LIVE = new Date("2026-10-19T00:00:00.000Z");

function makeOrder(txnid: string, payu: OrderDocument["payu"] = {}): OrderDocument {
  return {
    txnid,
    amount: FIXED_ORDER_AMOUNT,
    currency: FIXED_ORDER_CURRENCY,
    productInfo: FIXED_PRODUCT_NAME,
    customer: {
      name: "Private Person",
      phone: "9876543210",
      email: "private.person@example.com",
      company: "Secret Co",
      team: "1-5",
      industry: "Technology & software",
      revenue: "Below ₹50 lakh",
      businessProblem: "Another business challenge",
    },
    status: "PAID",
    payu: { status: "success", verifiedAt: new Date(), ...payu },
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

/** In-memory stand-in for the claim helpers, keyed by order. */
function makeRecovery(orders: OrderDocument[]) {
  const sends: string[] = [];
  const calls: { findOptions?: Parameters<RecoveryDependencies["findCandidates"]>[0] } = {};
  const dependencies: RecoveryDependencies = {
    notBefore: GO_LIVE,
    findCandidates: async (options) => {
      calls.findOptions = options;
      return orders;
    },
    emails: {
      claim: async (txnid, kind) => {
        const order = orders.find((o) => o.txnid === txnid);
        const sentKey = kind === "customer" ? "customerEmailSent" : "teamEmailSent";
        const claimKey = kind === "customer" ? "customerEmailClaimedAt" : "teamEmailClaimedAt";
        if (!order?.payu || order.payu[sentKey] || order.payu[claimKey]) return null;
        const now = new Date();
        order.payu = { ...order.payu, [claimKey]: now };
        return now;
      },
      markSent: async (txnid, kind) => {
        const order = orders.find((o) => o.txnid === txnid)!;
        order.payu = { ...order.payu, [kind === "customer" ? "customerEmailSent" : "teamEmailSent"]: true };
      },
      release: async (txnid, kind) => {
        const order = orders.find((o) => o.txnid === txnid)!;
        order.payu = { ...order.payu, [kind === "customer" ? "customerEmailClaimedAt" : "teamEmailClaimedAt"]: undefined };
      },
      sendCustomer: async (order) => {
        sends.push(`customer:${order.txnid}`);
        return true;
      },
      sendTeam: async (order) => {
        sends.push(`team:${order.txnid}`);
        return true;
      },
    },
  };
  return { dependencies, sends, calls };
}

const realMongoUri = process.env.MONGODB_URI;
const realCronSecret = process.env.CRON_SECRET;
beforeEach(() => {
  delete process.env.MONGODB_URI; // route tests must never reach a database
  process.env.CRON_SECRET = SECRET;
  process.env.PAYMENT_EMAIL_RECOVERY_START = GO_LIVE.toISOString();
});
afterEach(() => {
  delete process.env.PAYMENT_EMAIL_RECOVERY_START;
  if (realMongoUri === undefined) delete process.env.MONGODB_URI;
  else process.env.MONGODB_URI = realMongoUri;
  if (realCronSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = realCronSecret;
});

test("cron authorization requires the exact Bearer secret and fails closed", () => {
  assert.equal(isAuthorizedCronRequest(`Bearer ${SECRET}`, SECRET), true);
  assert.equal(isAuthorizedCronRequest(`Bearer ${SECRET}x`, SECRET), false);
  assert.equal(isAuthorizedCronRequest(SECRET, SECRET), false); // no Bearer prefix
  assert.equal(isAuthorizedCronRequest(null, SECRET), false);
  assert.equal(isAuthorizedCronRequest("Bearer ", SECRET), false);
  assert.equal(isAuthorizedCronRequest(`Bearer ${SECRET}`, undefined), false);
  assert.equal(isAuthorizedCronRequest("Bearer ", ""), false);
  // Too-short secrets are rejected even when they match.
  assert.equal(isAuthorizedCronRequest("Bearer short", "short"), false);
});

test("cron route rejects missing, wrong and unconfigured credentials", async () => {
  const url = "http://localhost/api/cron/retry-payment-emails";
  assert.equal((await GET(new NextRequest(url))).status, 401);
  assert.equal(
    (await GET(new NextRequest(url, { headers: { authorization: "Bearer wrong-secret-value" } }))).status,
    401
  );
  delete process.env.CRON_SECRET;
  assert.equal(
    (await GET(new NextRequest(url, { headers: { authorization: `Bearer ${SECRET}` } }))).status,
    401
  );
});

test("cron route accepts the correct secret and returns a summary without customer data", async () => {
  const response = await GET(
    new NextRequest("http://localhost/api/cron/retry-payment-emails", {
      headers: { authorization: `Bearer ${SECRET}` },
    })
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    scanned: 0,
    customerSent: 0,
    teamSent: 0,
    failed: 0,
    skippedForTime: 0,
  });
});

test("go-live floor parsing accepts ISO timestamps and rejects missing or invalid values", () => {
  assert.equal(parseRecoveryStart("2026-10-19T00:00:00.000Z")?.toISOString(), "2026-10-19T00:00:00.000Z");
  assert.equal(parseRecoveryStart(undefined), null);
  assert.equal(parseRecoveryStart("  "), null);
  assert.equal(parseRecoveryStart("not-a-date"), null);
});

test("cron route refuses to run without a valid go-live floor, even with the right secret", async () => {
  const request = () =>
    new NextRequest("http://localhost/api/cron/retry-payment-emails", {
      headers: { authorization: `Bearer ${SECRET}` },
    });
  delete process.env.PAYMENT_EMAIL_RECOVERY_START;
  const missing = await GET(request());
  assert.equal(missing.status, 500);
  assert.deepEqual(await missing.json(), { error: "recovery_not_configured" });

  process.env.PAYMENT_EMAIL_RECOVERY_START = "garbage";
  assert.equal((await GET(request())).status, 500);
});

test("recovery queries with the 5 minute minimum age, 7 day window and small batch limit", async () => {
  const { dependencies, calls } = makeRecovery([]);
  const now = new Date();
  await retryPendingPaymentEmails({ ...dependencies, now: () => now });
  assert.deepEqual(calls.findOptions, {
    now,
    minAgeMs: 5 * 60 * 1000,
    maxAgeMs: 7 * 24 * 60 * 60 * 1000,
    notBefore: GO_LIVE,
    limit: 10,
  });
  assert.equal(RECOVERY_MIN_ORDER_AGE_MS, 5 * 60 * 1000);
  assert.equal(RECOVERY_MAX_ORDER_AGE_MS, 7 * 24 * 60 * 60 * 1000);
  assert.equal(RECOVERY_BATCH_LIMIT, 10);
});

test("recovery sends only the emails not yet confirmed sent", async () => {
  const orders = [
    makeOrder("GSA_A"), // nothing sent
    makeOrder("GSA_B", { customerEmailSent: true }), // team only
    makeOrder("GSA_C", { teamEmailSent: true }), // customer only
    makeOrder("GSA_D", { customerEmailSent: true, teamEmailSent: true }), // nothing
  ];
  const { dependencies, sends } = makeRecovery(orders);
  const summary = await retryPendingPaymentEmails(dependencies);
  assert.deepEqual(sends.sort(), ["customer:GSA_A", "customer:GSA_C", "team:GSA_A", "team:GSA_B"]);
  assert.deepEqual(summary, { scanned: 4, customerSent: 2, teamSent: 2, failed: 0, skippedForTime: 0 });
});

test("recovery does not take over an active claim", async () => {
  const orders = [makeOrder("GSA_A", { customerEmailClaimedAt: new Date() })];
  const { dependencies, sends } = makeRecovery(orders);
  const summary = await retryPendingPaymentEmails(dependencies);
  assert.deepEqual(sends, ["team:GSA_A"]);
  assert.equal(summary.customerSent, 0);
});

test("a second run after success sends nothing more", async () => {
  const orders = [makeOrder("GSA_A")];
  const { dependencies, sends } = makeRecovery(orders);
  await retryPendingPaymentEmails(dependencies);
  await retryPendingPaymentEmails(dependencies);
  assert.deepEqual(sends.sort(), ["customer:GSA_A", "team:GSA_A"]);
});

test("a failing email is counted, released for the next run and logged without customer data", async () => {
  const orders = [makeOrder("GSA_A"), makeOrder("GSA_B")];
  const { dependencies, sends } = makeRecovery(orders);
  dependencies.emails.sendTeam = async (order) => {
    if (order.txnid === "GSA_A") throw new Error("resend down for private.person@example.com");
    sends.push(`team:${order.txnid}`);
    return true;
  };

  const logged: string[] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => void logged.push(args.join(" "));
  let summary;
  try {
    summary = await retryPendingPaymentEmails(dependencies);
  } finally {
    console.error = realError;
  }

  // The failure did not stop the other order, and the failed email stays retryable.
  assert.deepEqual(summary, { scanned: 2, customerSent: 2, teamSent: 1, failed: 1, skippedForTime: 0 });
  assert.equal(orders[0].payu?.teamEmailSent, undefined);
  assert.equal(orders[0].payu?.teamEmailClaimedAt, undefined);
  assert.ok(logged.some((line) => line.includes("GSA_A")));
  const everything = logged.join("\n");
  for (const secret of ["Private Person", "private.person@example.com", "9876543210", "Secret Co", SECRET]) {
    assert.ok(!everything.includes(secret), `log leaks ${secret}`);
  }
});

test("claim errors for one order do not abort the batch", async () => {
  const orders = [makeOrder("GSA_A"), makeOrder("GSA_B")];
  const { dependencies } = makeRecovery(orders);
  const realClaim = dependencies.emails.claim;
  dependencies.emails.claim = async (txnid, kind) => {
    if (txnid === "GSA_A") throw new Error("database unavailable");
    return realClaim(txnid, kind);
  };
  const realError = console.error;
  console.error = () => undefined;
  let summary;
  try {
    summary = await retryPendingPaymentEmails(dependencies);
  } finally {
    console.error = realError;
  }
  assert.equal(summary.scanned, 2);
  assert.equal(summary.failed, 1);
  assert.equal(summary.customerSent, 1);
  assert.equal(summary.teamSent, 1);
});

test("recovery stops starting new orders once the time budget is spent", async () => {
  const orders = [makeOrder("GSA_A"), makeOrder("GSA_B"), makeOrder("GSA_C")];
  const { dependencies, sends } = makeRecovery(orders);
  let t = 0;
  dependencies.clock = () => {
    const value = t;
    t += RECOVERY_TIME_BUDGET_MS / 2 + 1; // each check advances beyond half the budget
    return value;
  };
  const summary = await retryPendingPaymentEmails(dependencies);
  assert.ok(summary.skippedForTime >= 1);
  assert.ok(sends.length < 6);
  assert.equal(summary.scanned, 3);
});
