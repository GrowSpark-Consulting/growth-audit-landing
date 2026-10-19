import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { MongoClient, type Db } from "mongodb";
import { NextRequest } from "next/server";
import { POST } from "../src/app/api/free-submit/route";
import { createMongoFreeStore } from "../src/lib/free-submissions";
import {
  describeZohoConfigProblem,
  FREE_PAGE_NOTE_TITLE,
  LEAD_SOURCE_FREE,
  LEAD_SOURCE_PAID,
  pushFreePageLeadToZoho,
  pushLeadToZoho,
} from "../src/lib/zoho";
import { defaultZohoSyncDependencies } from "../src/lib/zoho-sync";
import { ACCOUNTS_URL, FakeZoho, installFakeZoho, makeCustomer, TEST_SECRETS } from "./helpers/fake-zoho";

const ENV_KEYS = [
  "NODE_ENV",
  "MONGODB_URI",
  "ZOHO_CLIENT_ID",
  "ZOHO_CLIENT_SECRET",
  "ZOHO_REFRESH_TOKEN",
  "ZOHO_ACCOUNTS_URL",
  "ZOHO_API_VERSION",
] as const;

async function withEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string>>, run: () => Promise<void> | void) {
  const env = process.env as Record<string, string | undefined>;
  const previous = new Map(ENV_KEYS.map((key) => [key, env[key]]));
  for (const key of ENV_KEYS) delete env[key];
  Object.assign(env, values);
  try {
    await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
  }
}

type FindOne = (filter: Record<string, unknown>) => Promise<unknown>;

/** Fake MongoDB whose collections answer findOne per collection name. */
async function withCollections(
  handlers: Record<string, FindOne>,
  run: (calls: { collection: string; filter: Record<string, unknown> }[]) => Promise<void>
) {
  const previousGlobalPromise = global._mongoClientPromise;
  global._mongoClientPromise = undefined;
  const calls: { collection: string; filter: Record<string, unknown> }[] = [];
  const connectMock = mock.method(MongoClient.prototype, "connect", async function (this: MongoClient) {
    return this;
  });
  const dbMock = mock.method(MongoClient.prototype, "db", () => ({
    collection: (name: string) => ({
      createIndex: async () => "ok",
      findOne: async (filter: Record<string, unknown>) => {
        calls.push({ collection: name, filter });
        const handler = handlers[name];
        if (!handler) throw new Error(`unexpected collection ${name}`);
        return handler(filter);
      },
    }),
  }) as unknown as Db);
  try {
    await withEnv({ NODE_ENV: "development", MONGODB_URI: "mongodb://127.0.0.1:27017/test" }, () => run(calls));
  } finally {
    connectMock.mock.restore();
    dbMock.mock.restore();
    global._mongoClientPromise = previousGlobalPromise;
  }
}

const EMAIL = "asha@vermatextiles.example";

// --- Cross-workflow Lead linking (MongoDB lookups) -------------------------------

test("free submissions reuse a paid order's Lead when the applicant has no earlier free Lead", async () => {
  await withCollections(
    { free_submissions: async () => null, orders: async () => ({ zoho: { leadId: "5700000000000000201" } }) },
    async (calls) => {
      assert.equal(await createMongoFreeStore().findLinkedLeadId(EMAIL, "FREE_1"), "5700000000000000201");
      assert.deepEqual(
        calls.map((call) => call.collection),
        ["free_submissions", "orders"]
      );
      assert.deepEqual(calls[1].filter, {
        "customer.email": EMAIL,
        txnid: { $ne: "" },
        "zoho.leadId": { $exists: true },
      });
    }
  );
});

test("free submissions prefer the applicant's own earlier free Lead", async () => {
  await withCollections(
    { free_submissions: async () => ({ zoho: { leadId: "5700000000000000301" } }) },
    async (calls) => {
      assert.equal(await createMongoFreeStore().findLinkedLeadId(EMAIL, "FREE_2"), "5700000000000000301");
      assert.deepEqual(
        calls.map((call) => call.collection),
        ["free_submissions"]
      );
    }
  );
});

test("paid orders reuse a free-page Lead when no earlier order has one", async () => {
  await withCollections(
    { orders: async () => null, free_submissions: async () => ({ zoho: { leadId: "5700000000000000401" } }) },
    async (calls) => {
      assert.equal(await defaultZohoSyncDependencies.findLinkedLead(EMAIL, "GSA_1"), "5700000000000000401");
      assert.deepEqual(
        calls.map((call) => call.collection),
        ["orders", "free_submissions"]
      );
      assert.deepEqual(calls[1].filter, {
        "customer.email": EMAIL,
        submissionId: { $ne: "" },
        "zoho.leadId": { $exists: true },
      });
    }
  );
});

test("a failing lookup in the other workflow's collection never blocks a submission", async () => {
  await withCollections(
    {
      free_submissions: async () => null,
      orders: async () => {
        throw new Error("orders unavailable");
      },
    },
    async () => {
      assert.equal(await createMongoFreeStore().findLinkedLeadId(EMAIL, "FREE_3"), null);
    }
  );
  await withCollections(
    {
      orders: async () => null,
      free_submissions: async () => {
        throw new Error("free_submissions unavailable");
      },
    },
    async () => {
      assert.equal(await defaultZohoSyncDependencies.findLinkedLead(EMAIL, "GSA_2"), null);
    }
  );
});

// --- Lead Source rules across workflows (fake Zoho with search-index lag) --------

async function withFakeZoho(run: (fake: FakeZoho) => Promise<void>) {
  const fake = new FakeZoho();
  const restore = installFakeZoho(fake);
  try {
    await run(fake);
  } finally {
    restore();
  }
}

test("a free submission right after a payment keeps Growth Audit Paid and only adds a note", async () => {
  await withFakeZoho(async (fake) => {
    const paid = await pushLeadToZoho({
      customer: makeCustomer(),
      target: LEAD_SOURCE_PAID,
      submissionRef: "GSA_P1",
      payment: { amount: 999, currency: "INR" },
    });
    // The paid Lead is seconds old, so Zoho search cannot see it; the link carries its ID.
    const free = await pushFreePageLeadToZoho({
      customer: makeCustomer({ company: "Verma Textiles Pvt Ltd" }),
      submissionRef: "FREE_10",
      linkedLeadId: paid.leadId,
    });

    assert.deepEqual(free, { leadId: paid.leadId, created: false });
    assert.equal(fake.leads.length, 1);
    assert.equal(fake.leads[0].Lead_Source, "Growth Audit Paid");
    assert.equal(fake.leads[0].Company, "Verma Textiles", "existing details untouched");
    assert.equal(fake.count("POST", /\/Leads\/upsert$/), 1, "only the paid Lead was ever upserted");
    const note = fake.notes.find((n) => n.title === FREE_PAGE_NOTE_TITLE);
    assert.match(note?.content ?? "", /Company: Verma Textiles Pvt Ltd/);
  });
});

test("an unpaid checkout right after a free submission reuses the free-page Lead until payment", async () => {
  await withFakeZoho(async (fake) => {
    const free = await pushFreePageLeadToZoho({ customer: makeCustomer(), submissionRef: "FREE_11" });
    const unpaid = await pushLeadToZoho({
      customer: makeCustomer(),
      target: LEAD_SOURCE_FREE,
      submissionRef: "GSA_P2",
      linkedLeadId: free.leadId,
    });
    assert.equal(unpaid.leadId, free.leadId);
    assert.equal(fake.leads.length, 1);
    assert.equal(fake.leads[0].Lead_Source, "Growth Audit Free");
    assert.equal(fake.notes.filter((n) => n.title === FREE_PAGE_NOTE_TITLE).length, 1, "free-page marker kept");

    await pushLeadToZoho({
      customer: makeCustomer(),
      target: LEAD_SOURCE_PAID,
      submissionRef: "GSA_P2",
      known: { leadId: free.leadId, leadSource: unpaid.leadSource },
      payment: { amount: 999, currency: "INR" },
    });
    assert.equal(fake.leads[0].Lead_Source, "Growth Audit Paid", "a verified payment still upgrades it");
  });
});

// --- 503 diagnosis --------------------------------------------------------------

test("Zoho configuration problems are named without revealing any value", async () => {
  await withEnv({}, () => {
    assert.equal(
      describeZohoConfigProblem(),
      "missing ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN, ZOHO_ACCOUNTS_URL"
    );
  });
  await withEnv({ ...TEST_SECRETS, ZOHO_REFRESH_TOKEN: "  ", ZOHO_ACCOUNTS_URL: ACCOUNTS_URL }, () => {
    assert.equal(describeZohoConfigProblem(), "missing ZOHO_REFRESH_TOKEN");
  });
  await withEnv({ ...TEST_SECRETS, ZOHO_ACCOUNTS_URL: "accounts.zoho.in" }, () => {
    const problem = describeZohoConfigProblem() ?? "";
    assert.equal(problem, "ZOHO_ACCOUNTS_URL_INVALID");
    for (const secret of Object.values(TEST_SECRETS)) assert.equal(problem.includes(secret), false);
  });
  await withEnv({ ...TEST_SECRETS, ZOHO_ACCOUNTS_URL: ACCOUNTS_URL }, () => {
    assert.equal(describeZohoConfigProblem(), null);
  });
});

async function postFreeForm(ip: string) {
  const request = new NextRequest("http://localhost/api/free-submit", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(makeCustomer()),
  });
  const response = await POST(request);
  return { status: response.status, body: (await response.json()) as { ok: boolean; error?: string } };
}

test("the free form answers 503 and logs which setting is missing, touching nothing", async () => {
  const logged: unknown[][] = [];
  const errorSpy = mock.method(console, "error", (...args: unknown[]) => {
    logged.push(args);
  });
  const fetchSpy = mock.method(globalThis, "fetch", async () => {
    throw new Error("no network call expected");
  });
  const connectSpy = mock.method(MongoClient.prototype, "connect", async () => {
    throw new Error("no database call expected");
  });
  try {
    await withEnv({ ...TEST_SECRETS, ZOHO_ACCOUNTS_URL: ACCOUNTS_URL }, async () => {
      const result = await postFreeForm("203.0.113.10");
      assert.equal(result.status, 503);
      assert.deepEqual(result.body, {
        ok: false,
        error: "This form is temporarily unavailable. Please try again later.",
      });
    });
    await withEnv({ MONGODB_URI: "mongodb://127.0.0.1:27017/test", ZOHO_CLIENT_ID: TEST_SECRETS.ZOHO_CLIENT_ID }, async () => {
      assert.equal((await postFreeForm("203.0.113.11")).status, 503);
    });

    assert.deepEqual(
      logged.map((args) => (args[1] as { problem: string }).problem),
      ["missing MONGODB_URI", "missing ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN, ZOHO_ACCOUNTS_URL"]
    );
    const text = JSON.stringify(logged);
    for (const secret of Object.values(TEST_SECRETS)) assert.equal(text.includes(secret), false, "secret logged");
    assert.equal(fetchSpy.mock.callCount(), 0);
    assert.equal(connectSpy.mock.callCount(), 0);
  } finally {
    errorSpy.mock.restore();
    fetchSpy.mock.restore();
    connectSpy.mock.restore();
  }
});
