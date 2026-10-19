/**
 * Integration test for the payment-email claim helpers against a real MongoDB.
 *
 * Skipped unless TEST_MONGODB_URI is set. It must point at a disposable LOCAL
 * server; the test refuses any non-local host and always uses a uniquely named
 * throwaway database that is dropped afterwards. It never reads .env.local.
 *
 *   TEST_MONGODB_URI=mongodb://127.0.0.1:27017 npm test
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { MongoClient } from "mongodb";

const uri = process.env.TEST_MONGODB_URI;
const dbName = `growth_audit_itest_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;

function assertLocal(value: string) {
  const host = new URL(value.replace(/^mongodb(\+srv)?:/, "http:")).hostname;
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(host)) {
    throw new Error(`Refusing to run integration tests against non-local host: ${host}`);
  }
}

describe("payment email claims (MongoDB)", { skip: !uri }, () => {
  let client: MongoClient;
  // Loaded after env is set because src/lib/db.ts reads the database name at import.
  let orders: typeof import("../src/lib/orders");
  let callback: typeof import("../src/lib/payu-callback");
  let payu: typeof import("../src/lib/payu");

  before(async () => {
    assertLocal(uri!);
    process.env.MONGODB_URI = uri;
    process.env.MONGODB_DB_NAME = dbName;
    client = await new MongoClient(uri!).connect();
    orders = await import("../src/lib/orders");
    callback = await import("../src/lib/payu-callback");
    payu = await import("../src/lib/payu");
  });

  after(async () => {
    if (client) {
      await client.db(dbName).dropDatabase();
      await client.close();
    }
    const { getMongoClient } = await import("../src/lib/db");
    await (await getMongoClient()).close();
  });

  const customer = {
    name: "Test Customer",
    phone: "9876543210",
    email: "customer@example.com",
    company: "Example Co",
    team: "1-5",
    industry: "Technology & software",
    revenue: "Below ₹50 lakh",
    businessProblem: "Another business challenge",
  };

  async function seed(status: "PENDING" | "PAID" = "PAID") {
    const order = await orders.createOrder(customer);
    if (status === "PAID") {
      await client
        .db(dbName)
        .collection("orders")
        .updateOne(
          { txnid: order.txnid },
          { $set: { status: "PAID", "payu.status": "success", "payu.verifiedAt": new Date() } }
        );
    }
    return order.txnid;
  }

  const stored = async (txnid: string) =>
    client.db(dbName).collection("orders").findOne({ txnid });

  test("concurrent claims: exactly one winner per email, customer and team independent", async () => {
    const txnid = await seed();
    const [customerResults, teamResults] = await Promise.all([
      Promise.all(Array.from({ length: 25 }, () => orders.claimPaymentEmail(txnid, "customer"))),
      Promise.all(Array.from({ length: 25 }, () => orders.claimPaymentEmail(txnid, "team"))),
    ]);
    assert.equal(customerResults.filter(Boolean).length, 1);
    assert.equal(teamResults.filter(Boolean).length, 1);
  });

  test("an unexpired claim blocks others; an expired one can be reclaimed", async () => {
    const txnid = await seed();
    const t0 = new Date();
    assert.ok(await orders.claimPaymentEmail(txnid, "customer", t0));
    const inside = new Date(t0.getTime() + orders.EMAIL_CLAIM_LEASE_MS - 1000);
    assert.equal(await orders.claimPaymentEmail(txnid, "customer", inside), null);
    const outside = new Date(t0.getTime() + orders.EMAIL_CLAIM_LEASE_MS + 1000);
    assert.deepEqual(await orders.claimPaymentEmail(txnid, "customer", outside), outside);
    // The team email was never claimed and is unaffected.
    assert.ok(await orders.claimPaymentEmail(txnid, "team", outside));
  });

  test("concurrent reclaim of a stale claim has exactly one winner", async () => {
    const txnid = await seed();
    const t0 = new Date();
    await orders.claimPaymentEmail(txnid, "customer", t0);
    const later = new Date(t0.getTime() + orders.EMAIL_CLAIM_LEASE_MS + 1000);
    const results = await Promise.all(
      Array.from({ length: 25 }, () => orders.claimPaymentEmail(txnid, "customer", later))
    );
    assert.equal(results.filter(Boolean).length, 1);
  });

  test("a confirmed-sent email can never be claimed again", async () => {
    const txnid = await seed();
    const t0 = new Date();
    await orders.claimPaymentEmail(txnid, "customer", t0);
    await orders.markPaymentEmailSent(txnid, "customer");
    const muchLater = new Date(t0.getTime() + 24 * 60 * 60 * 1000);
    assert.equal(await orders.claimPaymentEmail(txnid, "customer", muchLater), null);
    assert.equal(((await stored(txnid))?.payu as { customerEmailSent?: boolean }).customerEmailSent, true);
  });

  test("release clears only the caller's own claim", async () => {
    const txnid = await seed();
    const first = new Date();
    await orders.claimPaymentEmail(txnid, "team", first);
    const second = new Date(first.getTime() + orders.EMAIL_CLAIM_LEASE_MS + 1000);
    await orders.claimPaymentEmail(txnid, "team", second);

    // The first attempt finishes late and fails: it must not clear the newer claim.
    await orders.releasePaymentEmailClaim(txnid, "team", first);
    assert.equal(await orders.claimPaymentEmail(txnid, "team", second), null);

    // The current owner releasing makes an immediate retry possible.
    await orders.releasePaymentEmailClaim(txnid, "team", second);
    assert.ok(await orders.claimPaymentEmail(txnid, "team", second));
  });

  test("unpaid orders cannot be claimed", async () => {
    const txnid = await seed("PENDING");
    assert.equal(await orders.claimPaymentEmail(txnid, "customer"), null);
    assert.equal(await orders.claimPaymentEmail("GSA_DOES_NOT_EXIST", "customer"), null);
  });

  test("recovery query returns only PAID orders inside the age window with unsent emails", async () => {
    const now = new Date();
    const minutesAgo = (m: number) => new Date(now.getTime() - m * 60 * 1000);
    const col = client.db(dbName).collection("orders");
    const make = async (
      verifiedAt: Date,
      patch: Record<string, unknown> = {},
      status: "PAID" | "FAILED" = "PAID"
    ) => {
      const txnid = await seed("PENDING");
      await col.updateOne(
        { txnid },
        { $set: { status, "payu.status": "success", "payu.verifiedAt": verifiedAt, ...patch } }
      );
      return txnid;
    };

    const eligibleOlder = await make(minutesAgo(60));
    const eligibleNewer = await make(minutesAgo(10), { "payu.customerEmailSent": true });
    const teamMissing = await make(minutesAgo(30), {
      "payu.customerEmailSent": true,
      "payu.teamEmailSent": false,
    });
    const tooNew = await make(minutesAgo(2));
    const tooOld = await make(minutesAgo(8 * 24 * 60));
    const allSent = await make(minutesAgo(20), {
      "payu.customerEmailSent": true,
      "payu.teamEmailSent": true,
    });
    const failed = await make(minutesAgo(20), {}, "FAILED");
    const mine = new Set([eligibleOlder, eligibleNewer, teamMissing, tooNew, tooOld, allSent, failed]);

    const window = {
      now,
      minAgeMs: 5 * 60 * 1000,
      maxAgeMs: 7 * 24 * 60 * 60 * 1000,
      notBefore: minutesAgo(24 * 60 * 3), // go-live three days ago
    };
    const beforeGoLive = await make(minutesAgo(24 * 60 * 5)); // inside 7 days, before go-live
    mine.add(beforeGoLive);
    const found = await orders.findPaidOrdersWithUnsentEmails({ ...window, limit: 50 });
    // Newest first; too-new, too-old, fully-sent and FAILED orders are absent.
    assert.deepEqual(
      found.filter((o) => mine.has(o.txnid)).map((o) => o.txnid),
      [eligibleNewer, teamMissing, eligibleOlder]
    );

    const limited = await orders.findPaidOrdersWithUnsentEmails({ ...window, limit: 1 });
    assert.equal(limited.length, 1);
  });

  test("concurrent PAID callbacks end to end send each email once and keep flags", async () => {
    const txnid = await seed("PENDING");
    const key = "itest-key";
    const salt = "itest-salt";
    const data: Record<string, string> = {
      key,
      txnid,
      amount: "999.00",
      productinfo: orders.FIXED_PRODUCT_NAME,
      firstname: "Test",
      email: customer.email,
      status: "success",
    };
    data.hash = payu.calculatePayUReverseHash(data, salt, false);

    const sent = { customer: 0, team: 0 };
    const dependencies: import("../src/lib/payu-callback").PayUCallbackDependencies = {
      config: { key, salt, mode: "test", paymentUrl: "https://test.payu.in/_payment" },
      findOrderByTxnid: orders.findOrderByTxnid,
      updateOrderStatus: orders.updateOrderStatus,
      verifyHash: (d, s) => d.hash === payu.calculatePayUReverseHash(d, s, false),
      createToken: (id, status, amount) => `${id}:${status}:${amount}`,
      paymentEmails: {
        claim: orders.claimPaymentEmail,
        markSent: orders.markPaymentEmailSent,
        release: orders.releasePaymentEmailClaim,
        sendCustomer: async () => {
          await new Promise((r) => setTimeout(r, 20));
          sent.customer += 1;
          return true;
        },
        // Team email fails on its first attempt only.
        sendTeam: async () => {
          await new Promise((r) => setTimeout(r, 20));
          sent.team += 1;
          return sent.team > 1;
        },
      },
    };

    const results = await Promise.all(
      Array.from({ length: 6 }, () => callback.processPayUCallback(data, dependencies))
    );
    assert.ok(results.every((r) => r.ok && r.status === "PAID"));
    assert.equal(sent.customer, 1);
    assert.equal(sent.team, 1);

    // A later callback retries only the failed team email.
    await callback.processPayUCallback(data, dependencies);
    assert.equal(sent.customer, 1);
    assert.equal(sent.team, 2);

    const payuDoc = (await stored(txnid))?.payu as Record<string, unknown>;
    assert.equal(payuDoc.customerEmailSent, true);
    assert.equal(payuDoc.teamEmailSent, true);
    assert.equal((await stored(txnid))?.status, "PAID");
  });
});
