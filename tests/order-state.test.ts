import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { MongoClient, type Collection, type Db } from "mongodb";
import {
  FIXED_ORDER_AMOUNT,
  FIXED_ORDER_CURRENCY,
  FIXED_PRODUCT_NAME,
  createOrder,
  type OrderDocument,
  updateOrderStatus,
} from "../src/lib/orders";

test("atomic order update returns the concurrent paid winner instead of stale failure", async () => {
  const env = process.env as Record<string, string | undefined>;
  const previousNodeEnv = env.NODE_ENV;
  const previousMongoUri = env.MONGODB_URI;
  const previousGlobalPromise = global._mongoClientPromise;
  env.NODE_ENV = "development";
  env.MONGODB_URI = "mongodb://127.0.0.1:27017/test";
  global._mongoClientPromise = undefined;

  const pending: OrderDocument = {
    txnid: "GSA_RACE_001",
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
    status: "PENDING",
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  let persisted = pending;
  let reads = 0;
  let observedFilter: unknown;
  const fakeCollection = {
    findOne: async () => {
      reads += 1;
      return reads === 1 ? pending : persisted;
    },
    findOneAndUpdate: async (filter: unknown) => {
      observedFilter = filter;
      // Simulate another callback committing success before this conditional
      // failure update can match its status predicate.
      persisted = {
        ...pending,
        status: "PAID",
        payu: { status: "success", verifiedAt: new Date() },
      };
      return null;
    },
  };
  const connectMock = mock.method(
    MongoClient.prototype,
    "connect",
    async function (this: MongoClient) {
      return this;
    }
  );
  const dbMock = mock.method(MongoClient.prototype, "db", () => ({
    collection: () => fakeCollection as unknown as Collection<OrderDocument>,
  }) as unknown as Db);

  try {
    const result = await updateOrderStatus("GSA_RACE_001", "FAILED", {
      status: "failure",
    });
    assert.deepEqual(observedFilter, {
      txnid: "GSA_RACE_001",
      status: { $ne: "PAID" },
    });
    assert.equal(result.success, true);
    assert.equal(result.order?.status, "PAID");
    assert.equal(result.alreadyPaid, true);
  } finally {
    connectMock.mock.restore();
    dbMock.mock.restore();
    if (previousNodeEnv === undefined) delete env.NODE_ENV;
    else env.NODE_ENV = previousNodeEnv;
    if (previousMongoUri === undefined) delete env.MONGODB_URI;
    else env.MONGODB_URI = previousMongoUri;
    global._mongoClientPromise = previousGlobalPromise;
  }
});

test("order creation refuses to return an unpersisted payable order", async () => {
  const env = process.env as Record<string, string | undefined>;
  const previousMongoUri = env.MONGODB_URI;
  delete env.MONGODB_URI;
  try {
    await assert.rejects(
      createOrder({
        name: "Test Customer",
        phone: "9876543210",
        email: "customer@example.com",
        company: "Example Co",
        team: "1-5",
        industry: "Technology & software",
        revenue: "Below â‚¹50 lakh",
        businessProblem: "Another business challenge",
      }),
      /MongoDB must be configured/
    );
  } finally {
    if (previousMongoUri === undefined) delete env.MONGODB_URI;
    else env.MONGODB_URI = previousMongoUri;
  }
});
