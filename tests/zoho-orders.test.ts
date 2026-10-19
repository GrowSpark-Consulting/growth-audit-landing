import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { MongoClient, type Collection, type Db } from "mongodb";
import {
  claimOrderForZohoSync,
  createOrder,
  findOrdersDueForZohoSync,
  findZohoLeadIdForEmail,
  saveZohoSyncResult,
  validateCustomerInput,
  type OrderDocument,
} from "../src/lib/orders";
import { makeCustomer } from "./helpers/fake-zoho";

interface Call {
  method: string;
  args: unknown[];
}

async function withFakeCollection(
  collection: Record<string, (...args: unknown[]) => unknown>,
  run: (calls: Call[]) => Promise<void>
) {
  const env = process.env as Record<string, string | undefined>;
  const previousNodeEnv = env.NODE_ENV;
  const previousMongoUri = env.MONGODB_URI;
  const previousGlobalPromise = global._mongoClientPromise;
  env.NODE_ENV = "development";
  env.MONGODB_URI = "mongodb://127.0.0.1:27017/test";
  global._mongoClientPromise = undefined;

  const calls: Call[] = [];
  const recording = Object.fromEntries(
    Object.entries(collection).map(([method, impl]) => [
      method,
      (...args: unknown[]) => {
        calls.push({ method, args });
        return impl(...args);
      },
    ])
  );
  const connectMock = mock.method(MongoClient.prototype, "connect", async function (this: MongoClient) {
    return this;
  });
  const dbMock = mock.method(MongoClient.prototype, "db", () => ({
    collection: () => recording as unknown as Collection<OrderDocument>,
  }) as unknown as Db);

  try {
    await run(calls);
  } finally {
    connectMock.mock.restore();
    dbMock.mock.restore();
    if (previousNodeEnv === undefined) delete env.NODE_ENV;
    else env.NODE_ENV = previousNodeEnv;
    if (previousMongoUri === undefined) delete env.MONGODB_URI;
    else env.MONGODB_URI = previousMongoUri;
    global._mongoClientPromise = previousGlobalPromise;
  }
}

test("new submissions are persisted with a PENDING CRM sync before payment starts", async () => {
  await withFakeCollection(
    {
      createIndex: async () => "ok",
      insertOne: async () => ({ insertedId: "id" }),
    },
    async (calls) => {
      const order = await createOrder(makeCustomer());
      assert.equal(order.status, "PENDING");
      assert.deepEqual(order.zoho, { status: "PENDING", attempts: 0 });

      const inserted = calls.find((call) => call.method === "insertOne")?.args[0] as OrderDocument;
      assert.deepEqual(inserted.zoho, { status: "PENDING", attempts: 0 });
      assert.deepEqual(inserted.customer, makeCustomer());
      const indexNames = calls
        .filter((call) => call.method === "createIndex")
        .map((call) => (call.args[1] as { name: string }).name);
      assert.ok(indexNames.includes("idx_zoho_status_created"));
      assert.ok(indexNames.includes("idx_customer_email"));
    }
  );
});

test("an earlier synced submission's Lead ID is looked up by email in MongoDB", async () => {
  await withFakeCollection(
    { findOne: async () => ({ zoho: { leadId: "5700000000000000101" } }) },
    async (calls) => {
      assert.equal(await findZohoLeadIdForEmail("asha@vermatextiles.example", "GSA_2"), "5700000000000000101");
      assert.deepEqual(calls[0].args, [
        { "customer.email": "asha@vermatextiles.example", txnid: { $ne: "GSA_2" }, "zoho.leadId": { $exists: true } },
        { sort: { createdAt: -1 }, projection: { "zoho.leadId": 1 } },
      ]);
    }
  );
});

test("CRM sync lease is claimed atomically and only when free or expired", async () => {
  const now = new Date("2026-10-19T10:00:00.000Z");
  await withFakeCollection({ findOneAndUpdate: async () => null }, async (calls) => {
    assert.equal(await claimOrderForZohoSync("GSA_1", now), null);
    const [filter, update, options] = calls[0].args;
    assert.deepEqual(filter, {
      txnid: "GSA_1",
      $or: [{ "zoho.lockedUntil": { $exists: false } }, { "zoho.lockedUntil": { $lte: now } }],
    });
    assert.deepEqual(update, { $set: { "zoho.lockedUntil": new Date(now.getTime() + 90_000) } });
    assert.deepEqual(options, { returnDocument: "after" });
  });
});

test("sync results update only CRM fields, release the lease, and respect paid orders", async () => {
  const now = new Date("2026-10-19T10:00:00.000Z");
  let matched = 1;
  await withFakeCollection({ updateOne: async () => ({ matchedCount: matched }) }, async (calls) => {
    assert.equal(
      await saveZohoSyncResult(
        "GSA_1",
        { status: "SYNCED", leadId: "570001", leadSource: "Growth Audit Free", countAttempt: true, onlyIfNotPaid: true },
        now
      ),
      true
    );
    assert.deepEqual(calls[0].args, [
      { txnid: "GSA_1", status: { $ne: "PAID" } },
      {
        $set: {
          "zoho.status": "SYNCED",
          "zoho.lastAttemptAt": now,
          "zoho.leadId": "570001",
          "zoho.leadSource": "Growth Audit Free",
          "zoho.syncedAt": now,
        },
        $unset: { "zoho.lockedUntil": "", "zoho.lastError": "", "zoho.nextRetryAt": "" },
        $inc: { "zoho.attempts": 1 },
      },
    ]);

    matched = 0;
    const retryAt = new Date(now.getTime() + 60_000);
    assert.equal(
      await saveZohoSyncResult(
        "GSA_1",
        { status: "RETRY_REQUIRED", error: "TIMEOUT", nextRetryAt: retryAt, countAttempt: false },
        now
      ),
      false
    );
    assert.deepEqual(calls[1].args, [
      { txnid: "GSA_1" },
      {
        $set: {
          "zoho.status": "RETRY_REQUIRED",
          "zoho.lastAttemptAt": now,
          "zoho.lastError": "TIMEOUT",
          "zoho.nextRetryAt": retryAt,
        },
        $unset: { "zoho.lockedUntil": "" },
      },
    ]);
  });
});

test("retry query selects stale pending, due retries, and unpaid-upgrade orders only", async () => {
  const now = new Date("2026-10-19T10:00:00.000Z");
  await withFakeCollection(
    { find: () => ({ toArray: async () => [{ txnid: "GSA_1" }, { txnid: "GSA_2" }] }) },
    async (calls) => {
      assert.deepEqual(await findOrdersDueForZohoSync(10, now), ["GSA_1", "GSA_2"]);
      const [filter, options] = calls[0].args;
      assert.deepEqual(filter, {
        $or: [
          { "zoho.status": "PENDING", createdAt: { $lte: new Date(now.getTime() - 120_000) } },
          {
            "zoho.status": "RETRY_REQUIRED",
            $or: [{ "zoho.nextRetryAt": { $exists: false } }, { "zoho.nextRetryAt": { $lte: now } }],
          },
          { status: "PAID", "zoho.status": "SYNCED", "zoho.leadSource": { $ne: "Growth Audit Paid" } },
        ],
      });
      assert.deepEqual(options, { projection: { txnid: 1 }, sort: { createdAt: 1 }, limit: 10 });
    }
  );
});

test("server validation rejects malformed contact data before anything is stored", () => {
  const base = {
    ...makeCustomer(),
    email: "Asha@VermaTextiles.example",
  };
  const ok = validateCustomerInput(base);
  assert.equal(ok.valid, true);
  assert.equal(ok.data?.email, "asha@vermatextiles.example");

  for (const [typed, stored] of [
    ["www.example.in", "https://www.example.in"],
    ["example.in", "https://example.in"],
    ["http://example.co.in/about", "http://example.co.in/about"],
  ]) {
    assert.equal(validateCustomerInput({ ...base, website: typed }).data?.website, stored, typed);
  }
  assert.equal(validateCustomerInput({ ...base, website: "" }).data?.website, undefined);

  const cases: [Partial<typeof base>, RegExp][] = [
    [{ name: "" }, /Full name/],
    [{ email: "not-an-email" }, /email/],
    [{ phone: "12345" }, /phone/],
    [{ phone: "+91 98765 4321O" }, /phone/],
    [{ company: "" }, /Company/],
    [{ website: `https://example.com/${"a".repeat(260)}` }, /website/],
    [{ website: "hello" }, /website/],
    [{ website: "ftp://example.in" }, /website/],
    [{ website: "javascript:alert(1)" }, /website/],
    [{ team: "1000+" }, /team size/],
    [{ businessProblem: "<script>alert(1)</script>" }, /business challenge/],
  ];
  for (const [override, message] of cases) {
    const result = validateCustomerInput({ ...base, ...override });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((error) => message.test(error)), `expected ${message} for ${JSON.stringify(override)}`);
  }
});
