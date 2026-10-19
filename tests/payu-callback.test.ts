import assert from "node:assert/strict";
import test from "node:test";
import {
  FIXED_ORDER_AMOUNT,
  FIXED_ORDER_CURRENCY,
  FIXED_PRODUCT_NAME,
  type OrderDocument,
} from "../src/lib/orders";
import {
  calculatePayUReverseHash,
  type PayUResponseData,
} from "../src/lib/payu";
import {
  processPayUCallback,
  type PayUCallbackDependencies,
} from "../src/lib/payu-callback";
import { paymentEmailIdempotencyKey } from "../src/lib/email";

const config = {
  key: "test-merchant-key",
  salt: "test-merchant-salt",
  mode: "test" as const,
  paymentUrl: "https://test.payu.in/_payment",
};

function makeOrder(txnid = "GSA_TEST_001", status: OrderDocument["status"] = "PENDING"): OrderDocument {
  return {
    txnid,
    amount: FIXED_ORDER_AMOUNT,
    currency: FIXED_ORDER_CURRENCY,
    productInfo: FIXED_PRODUCT_NAME,
    customer: {
      name: "Test Customer",
      phone: "9876543210",
      email: "customer@example.com",
      company: "Example Co",
      team: "1-5",
      industry: "Technology & software",
      revenue: "Below â‚¹50 lakh",
      businessProblem: "Another business challenge",
    },
    status,
    ...(status === "PAID"
      ? { payu: { status: "success", verifiedAt: new Date() } }
      : {}),
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function makeCallback(overrides: Partial<PayUResponseData> = {}): PayUResponseData {
  const data: PayUResponseData = {
    key: config.key,
    txnid: "GSA_TEST_001",
    amount: "999.00",
    productinfo: FIXED_PRODUCT_NAME,
    firstname: "Test",
    email: "customer@example.com",
    status: "success",
    ...overrides,
  };
  data.hash = calculatePayUReverseHash(data, config.salt, Boolean(data.additionalCharges || data.additional_charges));
  return data;
}

function makeHarness(initial = makeOrder()) {
  let order: OrderDocument | null = initial;
  let updateCalls = 0;
  const dependencies: PayUCallbackDependencies = {
    config,
    findOrderByTxnid: async (txnid) =>
      order?.txnid === txnid ? { ...order, payu: order.payu ? { ...order.payu } : undefined } : null,
    updateOrderStatus: async (txnid, status, details) => {
      updateCalls += 1;
      if (!order || order.txnid !== txnid) return { success: false, order: null };
      if (order.status !== "PAID") {
        order = {
          ...order,
          status,
          payu: { ...details, verifiedAt: new Date() },
          updatedAt: new Date(),
        };
      }
      return { success: true, order };
    },
    verifyHash: (data, salt) => {
      const expected = calculatePayUReverseHash(
        data,
        salt,
        Boolean(data.additionalCharges || data.additional_charges)
      );
      return Boolean(data.hash && data.hash === expected);
    },
    createToken: (txnid, status, amount) => `${txnid}:${status}:${amount}`,
  };
  return {
    dependencies,
    currentOrder: () => order,
    updateCalls: () => updateCalls,
  };
}

test("paid order followed by a signed failure callback remains paid", async () => {
  const harness = makeHarness();
  const first = await processPayUCallback(makeCallback(), harness.dependencies);
  assert.equal(first.ok, true);

  const contradictory = makeCallback({ status: "failure" });
  const second = await processPayUCallback(contradictory, harness.dependencies);
  assert.deepEqual(second, {
    ok: true,
    txnid: "GSA_TEST_001",
    status: "PAID",
    token: "GSA_TEST_001:PAID:999",
  });
  assert.equal(harness.currentOrder()?.status, "PAID");
});

test("repeated success callbacks return the persisted paid state", async () => {
  const harness = makeHarness();
  const callback = makeCallback();
  const first = await processPayUCallback(callback, harness.dependencies);
  const second = await processPayUCallback(callback, harness.dependencies);
  assert.equal(first.ok && first.status, "PAID");
  assert.equal(second.ok && second.status, "PAID");
  assert.equal(harness.currentOrder()?.status, "PAID");
  assert.equal(harness.updateCalls(), 2);
});

test("tampered callback hash is rejected before order access or update", async () => {
  const harness = makeHarness();
  const callback = makeCallback();
  callback.amount = "1.00";
  const result = await processPayUCallback(callback, harness.dependencies);
  assert.deepEqual(result, { ok: false, error: "hash_mismatch", txnid: "GSA_TEST_001" });
  assert.equal(harness.updateCalls(), 0);
});

test("callback with an incorrect merchant key is rejected before order access", async () => {
  const harness = makeHarness();
  const callback = makeCallback({ key: "another-merchant" });
  let readCalls = 0;
  harness.dependencies.findOrderByTxnid = async () => {
    readCalls += 1;
    return harness.currentOrder();
  };

  const result = await processPayUCallback(callback, harness.dependencies);
  assert.deepEqual(result, {
    ok: false,
    error: "invalid_merchant",
    txnid: "GSA_TEST_001",
  });
  assert.equal(readCalls, 0);
  assert.equal(harness.updateCalls(), 0);
});

test("validly signed amount mismatch is rejected without updating the order", async () => {
  const harness = makeHarness();
  const result = await processPayUCallback(makeCallback({ amount: "998.99" }), harness.dependencies);
  assert.deepEqual(result, { ok: false, error: "amount_mismatch", txnid: "GSA_TEST_001" });
  assert.equal(harness.updateCalls(), 0);
});

test("callback transaction ID must match the persisted order", async () => {
  const otherOrder = makeOrder("GSA_OTHER");
  const harness = makeHarness(otherOrder);
  harness.dependencies.findOrderByTxnid = async () => otherOrder;
  const result = await processPayUCallback(makeCallback(), harness.dependencies);
  assert.deepEqual(result, { ok: false, error: "transaction_mismatch", txnid: "GSA_TEST_001" });
  assert.equal(harness.updateCalls(), 0);
});

test("database read failures return no token or success state", async () => {
  const harness = makeHarness();
  harness.dependencies.findOrderByTxnid = async () => {
    throw new Error("database unavailable");
  };
  const result = await processPayUCallback(makeCallback(), harness.dependencies);
  assert.deepEqual(result, { ok: false, error: "processing_error", txnid: "GSA_TEST_001" });
  assert.equal(harness.updateCalls(), 0);
});

test("database failure while reading back the persisted state returns no token", async () => {
  const harness = makeHarness();
  let reads = 0;
  harness.dependencies.findOrderByTxnid = async () => {
    reads += 1;
    if (reads === 1) return harness.currentOrder();
    throw new Error("database unavailable");
  };
  const result = await processPayUCallback(makeCallback(), harness.dependencies);
  assert.deepEqual(result, { ok: false, error: "processing_error", txnid: "GSA_TEST_001" });
  assert.equal(harness.currentOrder()?.status, "PAID");
});

test("database update failures return no token or success state", async () => {
  const harness = makeHarness();
  harness.dependencies.updateOrderStatus = async () => {
    throw new Error("database unavailable");
  };
  const result = await processPayUCallback(makeCallback(), harness.dependencies);
  assert.deepEqual(result, { ok: false, error: "processing_error", txnid: "GSA_TEST_001" });
});

test("missing persisted update result does not issue a verification token", async () => {
  const harness = makeHarness();
  harness.dependencies.updateOrderStatus = async () => ({ success: false, order: null });
  const result = await processPayUCallback(makeCallback(), harness.dependencies);
  assert.deepEqual(result, { ok: false, error: "processing_error", txnid: "GSA_TEST_001" });
});

test("missing token secret cannot produce a success result", async () => {
  const harness = makeHarness();
  harness.dependencies.createToken = () => "";
  const result = await processPayUCallback(makeCallback(), harness.dependencies);
  assert.deepEqual(result, { ok: false, error: "processing_error", txnid: "GSA_TEST_001" });
});

const LEASE_MS = 2 * 60 * 1000;

function withEmails(
  harness: ReturnType<typeof makeHarness>,
  overrides: Partial<NonNullable<PayUCallbackDependencies["paymentEmails"]>> = {}
) {
  const sent = { customer: 0, team: 0 };
  const clock = { now: Date.now() };
  const fields = (kind: "customer" | "team") =>
    kind === "customer"
      ? ({ sent: "customerEmailSent", claimedAt: "customerEmailClaimedAt" } as const)
      : ({ sent: "teamEmailSent", claimedAt: "teamEmailClaimedAt" } as const);
  // Mirrors the atomic conditional update: check-and-set with no await between.
  harness.dependencies.paymentEmails = {
    claim: async (_txnid, kind) => {
      const order = harness.currentOrder();
      const f = fields(kind);
      const claimedAt = order?.payu?.[f.claimedAt];
      if (!order || order.status !== "PAID" || order.payu?.[f.sent]) return null;
      if (claimedAt && claimedAt.getTime() >= clock.now - LEASE_MS) return null;
      const now = new Date(clock.now);
      order.payu = { ...order.payu, [f.claimedAt]: now };
      return now;
    },
    markSent: async (_txnid, kind) => {
      const order = harness.currentOrder();
      if (order) order.payu = { ...order.payu, [fields(kind).sent]: true };
    },
    release: async (_txnid, kind, claimedAt) => {
      const order = harness.currentOrder();
      const f = fields(kind);
      if (order?.payu?.[f.claimedAt]?.getTime() === claimedAt.getTime() && !order.payu[f.sent]) {
        order.payu = { ...order.payu, [f.claimedAt]: undefined };
      }
    },
    sendCustomer: async () => {
      await new Promise((r) => setTimeout(r, 5));
      sent.customer += 1;
      return true;
    },
    sendTeam: async () => {
      await new Promise((r) => setTimeout(r, 5));
      sent.team += 1;
      return true;
    },
    ...overrides,
  };
  return { sent, clock };
}

/** A PAID order whose customer-email claim was taken `ageMs` ago and never confirmed. */
function makePaidWithCustomerClaim(ageMs: number) {
  const order = makeOrder("GSA_TEST_001", "PAID");
  order.payu = { ...order.payu, customerEmailClaimedAt: new Date(Date.now() - ageMs) };
  return makeHarness(order);
}

test("payment emails are sent once on the first PAID callback", async () => {
  const harness = makeHarness();
  const { sent } = withEmails(harness);
  const result = await processPayUCallback(makeCallback(), harness.dependencies);
  assert.equal(result.ok && result.status, "PAID");
  assert.deepEqual(sent, { customer: 1, team: 1 });
  assert.equal(harness.currentOrder()?.payu?.customerEmailSent, true);
  assert.equal(harness.currentOrder()?.payu?.teamEmailSent, true);
});

test("duplicate PAID callbacks do not send payment emails again", async () => {
  const harness = makeHarness();
  const { sent } = withEmails(harness);
  const callback = makeCallback();
  await processPayUCallback(callback, harness.dependencies);
  const second = await processPayUCallback(callback, harness.dependencies);
  assert.equal(second.ok && second.status, "PAID");
  assert.deepEqual(sent, { customer: 1, team: 1 });
});

test("concurrent PAID callbacks send each email exactly once", async () => {
  const harness = makeHarness();
  const { sent } = withEmails(harness);
  const callback = makeCallback();
  const results = await Promise.all([
    processPayUCallback(callback, harness.dependencies),
    processPayUCallback(callback, harness.dependencies),
    processPayUCallback(callback, harness.dependencies),
  ]);
  assert.ok(results.every((r) => r.ok && r.status === "PAID"));
  assert.deepEqual(sent, { customer: 1, team: 1 });
});

test("payment emails are never sent for FAILED callbacks", async () => {
  const harness = makeHarness();
  const { sent } = withEmails(harness);
  const result = await processPayUCallback(makeCallback({ status: "failure" }), harness.dependencies);
  assert.equal(result.ok && result.status, "FAILED");
  assert.deepEqual(sent, { customer: 0, team: 0 });
});

test("team email failure is retried later without duplicating the customer email", async () => {
  const harness = makeHarness();
  let teamAttempts = 0;
  const { sent } = withEmails(harness, {
    sendTeam: async () => {
      teamAttempts += 1;
      return teamAttempts > 1; // first attempt fails
    },
  });
  const callback = makeCallback();
  const first = await processPayUCallback(callback, harness.dependencies);
  assert.equal(first.ok && first.status, "PAID");
  assert.equal(harness.currentOrder()?.payu?.customerEmailSent, true);
  assert.notEqual(harness.currentOrder()?.payu?.teamEmailSent, true);

  await processPayUCallback(callback, harness.dependencies);
  assert.equal(sent.customer, 1);
  assert.equal(teamAttempts, 2);
  assert.equal(harness.currentOrder()?.payu?.teamEmailSent, true);

  await processPayUCallback(callback, harness.dependencies);
  assert.equal(sent.customer, 1);
  assert.equal(teamAttempts, 2);
});

test("customer email failure is retried later without duplicating the team email", async () => {
  const harness = makeHarness();
  let customerAttempts = 0;
  const { sent } = withEmails(harness, {
    sendCustomer: async () => {
      customerAttempts += 1;
      return customerAttempts > 1;
    },
  });
  const callback = makeCallback();
  await processPayUCallback(callback, harness.dependencies);
  await processPayUCallback(callback, harness.dependencies);
  assert.equal(customerAttempts, 2);
  assert.equal(sent.team, 1);
});

test("an active (unexpired) claim is not taken over", async () => {
  const harness = makePaidWithCustomerClaim(30 * 1000);
  const { sent } = withEmails(harness);
  const result = await processPayUCallback(makeCallback(), harness.dependencies);
  assert.equal(result.ok && result.status, "PAID");
  assert.deepEqual(sent, { customer: 0, team: 1 });
});

test("a stale claim older than two minutes is reclaimed and sent", async () => {
  const harness = makePaidWithCustomerClaim(LEASE_MS + 1000);
  const { sent } = withEmails(harness);
  const result = await processPayUCallback(makeCallback(), harness.dependencies);
  assert.equal(result.ok && result.status, "PAID");
  assert.deepEqual(sent, { customer: 1, team: 1 });
  assert.equal(harness.currentOrder()?.payu?.customerEmailSent, true);
});

test("a confirmed-sent email is never reclaimed even with an old claim", async () => {
  const order = makeOrder("GSA_TEST_001", "PAID");
  order.payu = {
    ...order.payu,
    customerEmailSent: true,
    customerEmailClaimedAt: new Date(Date.now() - 10 * LEASE_MS),
  };
  const harness = makeHarness(order);
  const { sent } = withEmails(harness);
  await processPayUCallback(makeCallback(), harness.dependencies);
  assert.deepEqual(sent, { customer: 0, team: 1 });
});

test("concurrent callbacks reclaim a stale claim exactly once", async () => {
  const harness = makePaidWithCustomerClaim(LEASE_MS + 1000);
  const { sent } = withEmails(harness);
  const callback = makeCallback();
  await Promise.all([
    processPayUCallback(callback, harness.dependencies),
    processPayUCallback(callback, harness.dependencies),
    processPayUCallback(callback, harness.dependencies),
  ]);
  assert.deepEqual(sent, { customer: 1, team: 1 });
});

test("crash after Resend accepts but before success is recorded retries only after the lease", async () => {
  const harness = makeHarness();
  const { sent, clock } = withEmails(harness, {
    markSent: async () => {
      throw new Error("process died before recording success");
    },
  });
  const callback = makeCallback();
  const first = await processPayUCallback(callback, harness.dependencies);
  assert.equal(first.ok && first.status, "PAID");
  assert.deepEqual(sent, { customer: 1, team: 1 });

  // Within the lease: no duplicate attempt.
  await processPayUCallback(callback, harness.dependencies);
  assert.deepEqual(sent, { customer: 1, team: 1 });

  // After the lease an attempt is made again. Duplicate protection for this window
  // comes from the Resend idempotency key, not from this code.
  clock.now += LEASE_MS + 1000;
  await processPayUCallback(callback, harness.dependencies);
  assert.deepEqual(sent, { customer: 2, team: 2 });
});

test("Resend idempotency keys are stable per recipient and transaction", () => {
  assert.equal(
    paymentEmailIdempotencyKey("customer", "GSA_TEST_001"),
    "payment-confirmation/customer/GSA_TEST_001"
  );
  assert.notEqual(
    paymentEmailIdempotencyKey("customer", "GSA_TEST_001"),
    paymentEmailIdempotencyKey("team", "GSA_TEST_001")
  );
});

test("payment success is unaffected when email sending throws", async () => {
  const harness = makeHarness();
  withEmails(harness, {
    sendCustomer: async () => {
      throw new Error("resend down");
    },
    sendTeam: async () => {
      throw new Error("resend down");
    },
  });
  const result = await processPayUCallback(makeCallback(), harness.dependencies);
  assert.deepEqual(result, {
    ok: true,
    txnid: "GSA_TEST_001",
    status: "PAID",
    token: "GSA_TEST_001:PAID:999",
  });
  assert.equal(harness.currentOrder()?.status, "PAID");
  assert.notEqual(harness.currentOrder()?.payu?.customerEmailSent, true);
  assert.notEqual(harness.currentOrder()?.payu?.teamEmailSent, true);
});

test("payment success is unaffected when the email claim or release throws", async () => {
  const harness = makeHarness();
  withEmails(harness, {
    claim: async () => {
      throw new Error("database unavailable");
    },
  });
  const result = await processPayUCallback(makeCallback(), harness.dependencies);
  assert.equal(result.ok && result.status, "PAID");

  const harness2 = makeHarness();
  withEmails(harness2, {
    sendCustomer: async () => false,
    sendTeam: async () => false,
    release: async () => {
      throw new Error("database unavailable");
    },
  });
  const result2 = await processPayUCallback(makeCallback(), harness2.dependencies);
  assert.equal(result2.ok && result2.status, "PAID");
});
