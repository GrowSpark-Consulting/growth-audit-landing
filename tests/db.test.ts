import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { MongoClient } from "mongodb";
import { getMongoClient } from "../src/lib/db";

async function verifiesRetryAfterFailure(nodeEnv: string) {
  const env = process.env as Record<string, string | undefined>;
  const previousNodeEnv = env.NODE_ENV;
  const previousMongoUri = env.MONGODB_URI;
  const previousGlobalPromise = global._mongoClientPromise;
  const failure = new Error("simulated connection failure");
  let attempts = 0;
  let closeCalls = 0;

  env.NODE_ENV = nodeEnv;
  env.MONGODB_URI = "mongodb://127.0.0.1:27017/test";
  global._mongoClientPromise = undefined;

  const connectMock = mock.method(
    MongoClient.prototype,
    "connect",
    async function (this: MongoClient) {
      attempts += 1;
      if (attempts === 1) throw failure;
      return this;
    }
  );
  const closeMock = mock.method(MongoClient.prototype, "close", async () => {
    closeCalls += 1;
    throw new Error("simulated close failure");
  });

  try {
    await assert.rejects(getMongoClient(), (error: unknown) => error === failure);
    assert.equal(closeCalls, 1, "failed client should be closed");

    const client = await getMongoClient();
    assert.equal(attempts, 2, "next call should start a new connection attempt");
    assert.equal(await getMongoClient(), client, "successful connection should stay cached");
    assert.equal(attempts, 2, "cached success should not reconnect");
  } finally {
    connectMock.mock.restore();
    closeMock.mock.restore();
    if (previousNodeEnv === undefined) delete env.NODE_ENV;
    else env.NODE_ENV = previousNodeEnv;
    if (previousMongoUri === undefined) delete env.MONGODB_URI;
    else env.MONGODB_URI = previousMongoUri;
    global._mongoClientPromise = previousGlobalPromise;
  }
}

test("development connection cache clears a failed attempt and retries", async () => {
  await verifiesRetryAfterFailure("development");
});

test("production connection cache clears a failed attempt and retries", async () => {
  await verifiesRetryAfterFailure("production");
});
