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
