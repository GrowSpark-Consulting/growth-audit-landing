import assert from "node:assert/strict";
import test, { mock } from "node:test";
import {
  FIXED_ORDER_AMOUNT,
  FIXED_ORDER_CURRENCY,
  FIXED_PRODUCT_NAME,
  type CustomerData,
  type OrderDocument,
  type ZohoSyncUpdate,
} from "../src/lib/orders";
import { LEAD_SOURCE_FREE, LEAD_SOURCE_PAID, pushLeadToZoho, type PushLeadInput } from "../src/lib/zoho";
import {
  nextRetryDelayMs,
  retryDueZohoSyncs,
  syncOrderToZoho,
  ZOHO_MAX_ATTEMPTS,
  type ZohoSyncDependencies,
} from "../src/lib/zoho-sync";
import { FakeZoho, installFakeZoho, makeCustomer } from "./helpers/fake-zoho";

/** In-memory equivalent of the Mongo-backed sync helpers in orders.ts. */
class MemoryOrders {
  orders = new Map<string, OrderDocument>();
  now = new Date("2026-10-19T10:00:00.000Z");

  submit(txnid: string, customer: CustomerData = makeCustomer()): OrderDocument {
    const order: OrderDocument = {
      txnid,
      amount: FIXED_ORDER_AMOUNT,
      currency: FIXED_ORDER_CURRENCY,
      productInfo: FIXED_PRODUCT_NAME,
      customer,
      status: "PENDING",
      zoho: { status: "PENDING", attempts: 0 },
      createdAt: new Date(this.now),
      updatedAt: new Date(this.now),
    };
    this.orders.set(txnid, order);
    return order;
  }

  markPayment(txnid: string, status: "PAID" | "FAILED", mihpayid = "403993715531077182"): void {
    const order = this.get(txnid);
    if (order.status === "PAID") return;
    order.status = status;
    order.payu = { status: status === "PAID" ? "success" : "failure", mihpayid, verifiedAt: new Date(this.now) };
  }

  advance(ms: number): void {
    this.now = new Date(this.now.getTime() + ms);
  }

  get(txnid: string): OrderDocument {
    const order = this.orders.get(txnid);
    assert.ok(order, `order ${txnid} exists`);
    return order;
  }

  deps(fake: FakeZoho, overrides: Partial<ZohoSyncDependencies> = {}): ZohoSyncDependencies {
    return {
      isConfigured: () => true,
      claimOrder: async (txnid) => {
        const order = this.orders.get(txnid);
        if (!order) return null;
        const lockedUntil = order.zoho?.lockedUntil;
        if (lockedUntil && lockedUntil > this.now) return null;
        order.zoho = { status: "PENDING", attempts: 0, ...order.zoho, lockedUntil: new Date(this.now.getTime() + 90_000) };
        return structuredClone(order);
      },
      releaseClaim: async (txnid) => {
        delete this.get(txnid).zoho?.lockedUntil;
      },
      saveResult: async (txnid, update: ZohoSyncUpdate) => {
        const order = this.orders.get(txnid);
        if (!order || (update.onlyIfNotPaid && order.status === "PAID")) return false;
        const zoho = { status: update.status, attempts: 0, ...order.zoho };
        zoho.status = update.status;
        zoho.lastAttemptAt = new Date(this.now);
        if (update.leadId) zoho.leadId = update.leadId;
        if (update.leadSource) zoho.leadSource = update.leadSource;
        if (update.status === "SYNCED") zoho.syncedAt = new Date(this.now);
        zoho.lastError = update.error;
        zoho.nextRetryAt = update.nextRetryAt;
        if (update.countAttempt) zoho.attempts += 1;
        delete zoho.lockedUntil;
        order.zoho = zoho;
        return true;
      },
      findDue: async (limit, now) =>
        [...this.orders.values()]
          .filter((order) => {
            const zoho = order.zoho;
            if (!zoho) return false;
            if (zoho.status === "PENDING") return order.createdAt.getTime() <= now.getTime() - 120_000;
            if (zoho.status === "RETRY_REQUIRED") return !zoho.nextRetryAt || zoho.nextRetryAt <= now;
            return order.status === "PAID" && zoho.status === "SYNCED" && zoho.leadSource !== LEAD_SOURCE_PAID;
          })
          .slice(0, limit)
          .map((order) => order.txnid),
      findLinkedLead: async (email, excludeTxnid) =>
        [...this.orders.values()]
          .filter((order) => order.customer.email === email && order.txnid !== excludeTxnid && order.zoho?.leadId)
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]?.zoho?.leadId ?? null,
      pushLead: pushLeadToZoho,
      sleep: async () => undefined,
      now: () => new Date(this.now),
      ...overrides,
    };
  }
}

async function scenario(run: (fake: FakeZoho, store: MemoryOrders) => Promise<void>) {
  const fake = new FakeZoho();
  const store = new MemoryOrders();
  const restore = installFakeZoho(fake);
  const quiet = (["info", "warn", "error"] as const).map((level) => mock.method(console, level, () => undefined));
  try {
    await run(fake, store);
  } finally {
    for (const spy of quiet) spy.mock.restore();
    restore();
  }
}

test("Scenario A: submitted but unpaid -> one Lead with Growth Audit Free", async () => {
  await scenario(async (fake, store) => {
    store.submit("GSA_A");
    const outcome = await syncOrderToZoho("GSA_A", {}, store.deps(fake));

    assert.equal(outcome.result, "synced");
    assert.equal(fake.leads.length, 1);
    assert.equal(fake.leads[0].Lead_Source, "Growth Audit Free");
    const zoho = store.get("GSA_A").zoho;
    assert.equal(zoho?.status, "SYNCED");
    assert.equal(zoho?.leadId, fake.leads[0].id);
    assert.equal(zoho?.leadSource, LEAD_SOURCE_FREE);
    assert.equal(zoho?.attempts, 1);
    assert.equal(zoho?.lockedUntil, undefined);
  });
});

test("Scenario B: submitted and paid -> the same Lead becomes Growth Audit Paid", async () => {
  await scenario(async (fake, store) => {
    store.submit("GSA_B");
    await syncOrderToZoho("GSA_B", {}, store.deps(fake));
    const leadId = fake.leads[0].id;

    store.markPayment("GSA_B", "PAID");
    const outcome = await syncOrderToZoho("GSA_B", {}, store.deps(fake));

    assert.deepEqual(outcome, { result: "synced", leadId, leadSource: LEAD_SOURCE_PAID });
    assert.equal(fake.leads.length, 1);
    assert.equal(fake.leads[0].Lead_Source, "Growth Audit Paid");
    assert.equal(fake.notes.filter((note) => note.title === "Growth Audit payment confirmed").length, 1);
    assert.equal(store.get("GSA_B").zoho?.leadSource, LEAD_SOURCE_PAID);
  });
});

test("Scenario C: payment fails, user retries and pays -> same Lead upgraded to Paid", async () => {
  await scenario(async (fake, store) => {
    store.submit("GSA_C1");
    await syncOrderToZoho("GSA_C1", {}, store.deps(fake));
    store.markPayment("GSA_C1", "FAILED");
    assert.equal((await syncOrderToZoho("GSA_C1", {}, store.deps(fake))).result, "already_synced");
    assert.equal(fake.leads[0].Lead_Source, "Growth Audit Free", "failed payment keeps Free");

    // The failure page sends the user back to the same form, creating a new order.
    store.submit("GSA_C2");
    await syncOrderToZoho("GSA_C2", {}, store.deps(fake));
    store.markPayment("GSA_C2", "PAID");
    await syncOrderToZoho("GSA_C2", {}, store.deps(fake));

    assert.equal(fake.leads.length, 1, "no second Lead");
    assert.equal(fake.count("POST", /\/Leads\/upsert$/), 1, "retry reused the Lead by ID from MongoDB");
    assert.equal(fake.leads[0].Lead_Source, "Growth Audit Paid");
    assert.equal(store.get("GSA_C1").zoho?.leadId, fake.leads[0].id);
    assert.equal(store.get("GSA_C2").zoho?.leadId, fake.leads[0].id);
    assert.equal(store.get("GSA_C1").status, "FAILED", "failed attempt remains recorded");
    assert.deepEqual(store.get("GSA_C1").customer, makeCustomer(), "submission preserved");
  });
});

test("Scenario D: repeated and concurrent PayU success callbacks never duplicate CRM work", async () => {
  await scenario(async (fake, store) => {
    store.submit("GSA_D");
    await syncOrderToZoho("GSA_D", {}, store.deps(fake));
    store.markPayment("GSA_D", "PAID");

    const concurrent = await Promise.all([
      syncOrderToZoho("GSA_D", {}, store.deps(fake)),
      syncOrderToZoho("GSA_D", {}, store.deps(fake)),
    ]);
    const repeated = await syncOrderToZoho("GSA_D", { lockRetries: 3 }, store.deps(fake));

    assert.deepEqual(concurrent.map((outcome) => outcome.result).sort(), ["skipped", "synced"]);
    assert.equal(repeated.result, "already_synced");
    assert.equal(fake.leads.length, 1);
    assert.equal(fake.count("POST", /\/Leads\/upsert$/), 1);
    assert.equal(fake.count("PUT", /\/Leads\//), 1);
    assert.equal(fake.notes.length, 1);
  });
});

test("Scenario E: Zoho outage keeps the submission and a later retry syncs it once", async () => {
  await scenario(async (fake, store) => {
    store.submit("GSA_E");
    fake.down = true;
    const failed = await syncOrderToZoho("GSA_E", {}, store.deps(fake));

    assert.deepEqual(failed, { result: "retry_required", error: "NETWORK_ERROR" });
    const zoho = store.get("GSA_E").zoho;
    assert.equal(zoho?.status, "RETRY_REQUIRED");
    assert.equal(zoho?.attempts, 1);
    assert.equal(zoho?.nextRetryAt?.getTime(), store.now.getTime() + 60_000);
    assert.deepEqual(store.get("GSA_E").customer, makeCustomer());

    assert.equal((await retryDueZohoSyncs(10, store.deps(fake))).processed, 0, "backoff respected");

    fake.down = false;
    store.advance(61_000);
    const summary = await retryDueZohoSyncs(10, store.deps(fake));
    assert.deepEqual(summary, { processed: 1, synced: 1, retryRequired: 0, failed: 0, skipped: 0 });
    assert.equal(fake.leads.length, 1);
    assert.equal(store.get("GSA_E").zoho?.status, "SYNCED");
    assert.equal(store.get("GSA_E").zoho?.lastError, undefined);
  });
});

test("a timeout after Zoho created the Lead does not create a duplicate on retry", async () => {
  await scenario(async (fake, store) => {
    store.submit("GSA_T");
    fake.fail("POST", "/crm/v8/Leads/upsert", { kind: "commit-then-timeout" });
    const first = await syncOrderToZoho("GSA_T", {}, store.deps(fake));
    assert.deepEqual(first, { result: "retry_required", error: "TIMEOUT" });
    assert.equal(fake.leads.length, 1, "Zoho committed the record");

    store.advance(61_000);
    await retryDueZohoSyncs(10, store.deps(fake));
    assert.equal(fake.leads.length, 1);
    assert.equal(store.get("GSA_T").zoho?.leadId, fake.leads[0].id);
    assert.equal(fake.notes.length, 0, "identical data adds no extra note");
  });
});

test("payment verified while the free sync is running queues the Paid upgrade", async () => {
  await scenario(async (fake, store) => {
    store.submit("GSA_R");
    const deps = store.deps(fake, {
      pushLead: async (input: PushLeadInput) => {
        const result = await pushLeadToZoho(input);
        store.markPayment("GSA_R", "PAID");
        return result;
      },
    });

    const first = await syncOrderToZoho("GSA_R", {}, deps);
    assert.deepEqual(first, { result: "retry_required", error: "PAYMENT_CONFIRMED_DURING_SYNC" });
    assert.equal(store.get("GSA_R").zoho?.leadId, fake.leads[0].id);

    const summary = await retryDueZohoSyncs(10, store.deps(fake));
    assert.equal(summary.synced, 1);
    assert.equal(fake.leads.length, 1);
    assert.equal(fake.leads[0].Lead_Source, "Growth Audit Paid");
  });
});

test("payment failure before the first successful sync still creates a Free Lead", async () => {
  await scenario(async (fake, store) => {
    store.submit("GSA_F");
    store.markPayment("GSA_F", "FAILED");
    const outcome = await syncOrderToZoho("GSA_F", { lockRetries: 3 }, store.deps(fake));
    assert.equal(outcome.result, "synced");
    assert.equal(fake.leads[0].Lead_Source, "Growth Audit Free");
  });
});

test("Zoho validation errors fail permanently and are not retried automatically", async () => {
  await scenario(async (fake, store) => {
    store.submit("GSA_V");
    fake.fail("POST", "/crm/v8/Leads/upsert", {
      kind: "response",
      status: 400,
      body: { data: [{ code: "INVALID_DATA", details: { api_name: "Email" }, status: "error" }] },
    });
    const outcome = await syncOrderToZoho("GSA_V", {}, store.deps(fake));
    assert.deepEqual(outcome, { result: "failed", error: "INVALID_DATA:Email" });
    assert.equal(store.get("GSA_V").zoho?.status, "FAILED");

    store.advance(24 * 60 * 60_000);
    assert.equal((await retryDueZohoSyncs(10, store.deps(fake))).processed, 0);
  });
});

test("transient failures stop retrying after the maximum number of attempts", async () => {
  await scenario(async (fake, store) => {
    store.submit("GSA_M");
    fake.down = true;
    const results: string[] = [];
    for (let attempt = 0; attempt < ZOHO_MAX_ATTEMPTS; attempt++) {
      results.push((await syncOrderToZoho("GSA_M", {}, store.deps(fake))).result);
      store.advance(7 * 60 * 60_000);
    }
    assert.equal(results.at(-1), "failed");
    assert.equal(results.filter((result) => result === "retry_required").length, ZOHO_MAX_ATTEMPTS - 1);
    assert.equal(store.get("GSA_M").zoho?.attempts, ZOHO_MAX_ATTEMPTS);
  });
});

test("unconfigured Zoho leaves submissions queued without consuming attempts", async () => {
  await scenario(async (fake, store) => {
    store.submit("GSA_N");
    const outcome = await syncOrderToZoho("GSA_N", {}, store.deps(fake, { isConfigured: () => false }));
    assert.deepEqual(outcome, { result: "skipped", reason: "not_configured" });
    assert.deepEqual(store.get("GSA_N").zoho, { status: "PENDING", attempts: 0 });
    assert.equal(fake.requests.length, 0);
  });
});

test("retry backoff doubles from one minute and caps at six hours", () => {
  assert.equal(nextRetryDelayMs(1), 60_000);
  assert.equal(nextRetryDelayMs(2), 120_000);
  assert.equal(nextRetryDelayMs(5), 960_000);
  assert.equal(nextRetryDelayMs(20), 6 * 60 * 60_000);
});
