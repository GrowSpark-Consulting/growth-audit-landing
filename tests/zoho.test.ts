import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test, { mock } from "node:test";
import {
  buildLeadDescription,
  getZohoAccessToken,
  getZohoConfig,
  isZohoConfigured,
  LEAD_SOURCE_FREE,
  LEAD_SOURCE_PAID,
  mapCustomerToZohoLead,
  pushLeadToZoho,
  splitFullName,
  ZohoError,
} from "../src/lib/zoho";
import {
  ACCOUNTS_URL,
  API_DOMAIN,
  FakeZoho,
  installFakeZoho,
  makeCustomer,
  TEST_SECRETS,
} from "./helpers/fake-zoho";

async function withFake(run: (fake: FakeZoho) => Promise<void>, setup?: (fake: FakeZoho) => void) {
  const fake = new FakeZoho();
  setup?.(fake);
  const restore = installFakeZoho(fake);
  try {
    await run(fake);
  } finally {
    restore();
  }
}

async function rejectsWithCode(promise: Promise<unknown>, code: string, retryable: boolean) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof ZohoError, "expected a ZohoError");
    assert.equal(error.code, code);
    assert.equal(error.retryable, retryable);
    return true;
  });
}

// --- Field mapping -----------------------------------------------------------

test("maps every form field to the agreed Zoho Lead field", () => {
  assert.deepEqual(mapCustomerToZohoLead(makeCustomer(), LEAD_SOURCE_FREE), {
    First_Name: "Asha Rani",
    Last_Name: "Verma",
    Email: "asha@vermatextiles.example",
    Mobile: "+919876543210",
    Company: "Verma Textiles",
    Website: "https://vermatextiles.example",
    City: "Coimbatore",
    Description:
      "Team Size: 16-30 | Industry: Manufacturing with the annual revenue of ₹1-2 crore. " +
      "Challenge mentioned: Stuck at the same revenue for years",
    Lead_Source: "Growth Audit Free",
  });
});

test("full name keeps every part: last word is Last_Name, the rest is First_Name", () => {
  assert.deepEqual(splitFullName("  Asha   Rani Verma "), { firstName: "Asha Rani", lastName: "Verma", truncated: false });
  assert.deepEqual(splitFullName("Madonna"), { firstName: undefined, lastName: "Madonna", truncated: false });

  const single = mapCustomerToZohoLead(makeCustomer({ name: "Madonna" }), LEAD_SOURCE_FREE);
  assert.equal(single.Last_Name, "Madonna");
  assert.equal("First_Name" in single, false);
});

test("names longer than Zoho field limits are preserved in Description", () => {
  const longFirst = "Venkata Subrahmanya Lakshmi Narasimha Rao";
  const lead = mapCustomerToZohoLead(makeCustomer({ name: `${longFirst} Iyer` }), LEAD_SOURCE_FREE);
  assert.equal(lead.First_Name?.length, 40);
  assert.equal(lead.Last_Name, "Iyer");
  assert.match(lead.Description, new RegExp(`Stuck at the same revenue for years\\nFull name: ${longFirst} Iyer$`));
});

test("Description only includes values that were submitted", () => {
  assert.equal(buildLeadDescription({ team: "1-5", industry: "" }), "Team Size: 1-5.");
  assert.equal(
    buildLeadDescription({ revenue: "₹3-5 crore", businessProblem: "Another business challenge" }),
    "The annual revenue of ₹3-5 crore. Challenge mentioned: Another business challenge"
  );
  assert.equal(buildLeadDescription({}), "");
  const noWebsite = mapCustomerToZohoLead(makeCustomer({ website: undefined }), LEAD_SOURCE_PAID);
  assert.equal("Website" in noWebsite, false);
  assert.equal(noWebsite.Lead_Source, "Growth Audit Paid");
});

// --- Configuration -----------------------------------------------------------

test("configuration requires credentials and an https Zoho accounts domain", () => {
  const env = process.env as Record<string, string | undefined>;
  const keys = [...Object.keys(TEST_SECRETS), "ZOHO_ACCOUNTS_URL", "ZOHO_API_VERSION"];
  const previous = new Map(keys.map((key) => [key, env[key]]));
  try {
    for (const key of keys) delete env[key];
    assert.equal(isZohoConfigured(), false);

    Object.assign(env, TEST_SECRETS, { ZOHO_ACCOUNTS_URL: "https://accounts.zoho.in/" });
    assert.equal(getZohoConfig().accountsUrl, "https://accounts.zoho.in");
    assert.equal(getZohoConfig().apiVersion, "v8");

    for (const bad of ["https://evil.example.com", "http://accounts.zoho.in", "https://accounts.zoho.in.evil.com"]) {
      env.ZOHO_ACCOUNTS_URL = bad;
      assert.throws(() => getZohoConfig(), (error: unknown) => (error as ZohoError).code === "ZOHO_ACCOUNTS_URL_INVALID");
    }
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
  }
});

// --- OAuth token management --------------------------------------------------

test("refresh token is exchanged once, cached, and the returned api_domain is used", async () => {
  await withFake(async (fake) => {
    await pushLeadToZoho({ customer: makeCustomer(), target: LEAD_SOURCE_FREE, submissionRef: "GSA_1" });
    await pushLeadToZoho({
      customer: makeCustomer({ email: "second@example.com" }),
      target: LEAD_SOURCE_FREE,
      submissionRef: "GSA_2",
    });

    assert.equal(fake.tokenRequests.length, 1);
    const tokenRequest = fake.tokenRequests[0];
    assert.equal(tokenRequest.get("grant_type"), "refresh_token");
    assert.equal(tokenRequest.get("client_id"), TEST_SECRETS.ZOHO_CLIENT_ID);
    assert.equal(tokenRequest.get("refresh_token"), TEST_SECRETS.ZOHO_REFRESH_TOKEN);

    const apiRequests = fake.requests.filter((request) => request.url.origin !== ACCOUNTS_URL);
    assert.ok(apiRequests.length > 0);
    for (const request of apiRequests) {
      assert.equal(request.url.origin, API_DOMAIN);
      assert.match(request.url.pathname, /^\/crm\/v8\//);
      assert.equal(request.headers.get("authorization"), "Zoho-oauthtoken tok-1");
    }
  });
});

test("concurrent callers share a single token refresh", async () => {
  await withFake(async (fake) => {
    const tokens = await Promise.all([getZohoAccessToken(), getZohoAccessToken(), getZohoAccessToken()]);
    assert.equal(fake.tokenRequests.length, 1);
    assert.deepEqual(new Set(tokens.map((token) => token.accessToken)), new Set(["tok-1"]));
  });
});

test("an expired access token is refreshed and the request retried once", async () => {
  await withFake(async (fake) => {
    await pushLeadToZoho({ customer: makeCustomer(), target: LEAD_SOURCE_FREE, submissionRef: "GSA_1" });
    fake.expireAllTokens();
    const result = await pushLeadToZoho({
      customer: makeCustomer(),
      target: LEAD_SOURCE_PAID,
      submissionRef: "GSA_1",
      known: { leadId: fake.leads[0].id, leadSource: LEAD_SOURCE_FREE },
    });

    assert.equal(result.leadSource, LEAD_SOURCE_PAID);
    assert.equal(fake.tokenRequests.length, 2);
    assert.equal(fake.leads[0].Lead_Source, "Growth Audit Paid");
  });
});

test("a token response pointing at a non-Zoho domain is rejected before any data is sent", async () => {
  await withFake(
    async (fake) => {
      await rejectsWithCode(
        pushLeadToZoho({ customer: makeCustomer(), target: LEAD_SOURCE_FREE, submissionRef: "GSA_1" }),
        "OAUTH_INVALID_TOKEN_RESPONSE",
        true
      );
      assert.equal(fake.requests.filter((request) => request.url.origin !== ACCOUNTS_URL).length, 0);
    },
    (fake) => {
      fake.tokenApiDomain = "https://attacker.example.com";
    }
  );
});

// --- Lead creation, upgrade, and duplicate policy ----------------------------

test("a new free submission creates exactly one Lead with Lead_Source Growth Audit Free", async () => {
  await withFake(async (fake) => {
    const result = await pushLeadToZoho({ customer: makeCustomer(), target: LEAD_SOURCE_FREE, submissionRef: "GSA_1" });

    assert.equal(fake.leads.length, 1);
    assert.equal(result.leadId, fake.leads[0].id);
    assert.equal(result.leadSource, LEAD_SOURCE_FREE);
    assert.equal(fake.leads[0].Lead_Source, "Growth Audit Free");
    assert.equal(fake.leads[0].Last_Name, "Verma");
    assert.equal(fake.notes.length, 0);
  });
});

test("a verified payment updates only Lead_Source on the stored Lead and adds a payment note", async () => {
  await withFake(async (fake) => {
    const free = await pushLeadToZoho({ customer: makeCustomer(), target: LEAD_SOURCE_FREE, submissionRef: "GSA_1" });
    const paid = await pushLeadToZoho({
      customer: makeCustomer(),
      target: LEAD_SOURCE_PAID,
      submissionRef: "GSA_1",
      known: { leadId: free.leadId, leadSource: LEAD_SOURCE_FREE },
      payment: { amount: 999, currency: "INR", payuId: "403993715531077182" },
    });

    assert.deepEqual(paid, { leadId: free.leadId, leadSource: LEAD_SOURCE_PAID });
    assert.equal(fake.leads.length, 1);
    const put = fake.requests.find((request) => request.method === "PUT");
    assert.deepEqual(put?.body, { data: [{ Lead_Source: "Growth Audit Paid" }] });
    assert.equal(fake.notes.length, 1);
    assert.match(fake.notes[0].content, /INR 999\.00/);
    assert.match(fake.notes[0].content, /GSA_1/);
    assert.match(fake.notes[0].content, /403993715531077182/);
  });
});

test("an existing CRM Lead with the same email is reused without overwriting its data", async () => {
  await withFake(
    async (fake) => {
      const result = await pushLeadToZoho({ customer: makeCustomer(), target: LEAD_SOURCE_FREE, submissionRef: "GSA_9" });

      assert.equal(result.leadId, "4100000000001");
      assert.equal(fake.count("POST", /\/Leads\/upsert$/), 0, "no new Lead is created");
      const lead = fake.leads[0];
      assert.equal(lead.Last_Name, "Kumar", "existing name untouched");
      assert.equal(lead.Company, "Old Co", "existing company untouched");
      assert.equal(lead.Description, "Met at expo", "existing description untouched");
      assert.equal(lead.Mobile, "+919876543210", "empty field filled");
      assert.equal(lead.Lead_Source, "Growth Audit Free");
      assert.equal(fake.notes.length, 1, "new submission preserved as a note");
      assert.match(fake.notes[0].content, /Company: Verma Textiles/);
      assert.match(fake.notes[0].content, /Previous Lead Source: Advertisement/);
    },
    (fake) => {
      fake.leads.push({
        id: "4100000000001",
        Email: "asha@vermatextiles.example",
        Last_Name: "Kumar",
        Company: "Old Co",
        Description: "Met at expo",
        Lead_Source: "Advertisement",
      });
    }
  );
});

test("a Lead that already paid is never downgraded to Growth Audit Free", async () => {
  await withFake(
    async (fake) => {
      const result = await pushLeadToZoho({ customer: makeCustomer(), target: LEAD_SOURCE_FREE, submissionRef: "GSA_2" });
      assert.equal(result.leadSource, LEAD_SOURCE_PAID);
      assert.equal(fake.leads[0].Lead_Source, "Growth Audit Paid");
    },
    (fake) => {
      fake.leads.push({
        id: "4100000000002",
        ...mapCustomerToZohoLead(makeCustomer(), LEAD_SOURCE_PAID),
      });
    }
  );
});

test("a Lead too new to appear in search is matched by the Email upsert, not duplicated", async () => {
  await withFake(async (fake) => {
    const first = await pushLeadToZoho({ customer: makeCustomer(), target: LEAD_SOURCE_FREE, submissionRef: "GSA_3" });
    const second = await pushLeadToZoho({ customer: makeCustomer(), target: LEAD_SOURCE_FREE, submissionRef: "GSA_3B" });

    assert.equal(second.leadId, first.leadId);
    assert.equal(fake.leads.length, 1);
    assert.equal(fake.count("POST", /\/Leads\/upsert$/), 2, "search missed the fresh Lead");
  });
});

test("an earlier submission's Lead is reused by ID before search can see it", async () => {
  await withFake(async (fake) => {
    const first = await pushLeadToZoho({ customer: makeCustomer(), target: LEAD_SOURCE_FREE, submissionRef: "GSA_L1" });
    const searchesBefore = fake.count("GET", /\/Leads\/search$/);
    const second = await pushLeadToZoho({
      customer: makeCustomer({ company: "Verma Textiles Pvt Ltd" }),
      target: LEAD_SOURCE_FREE,
      submissionRef: "GSA_L2",
      linkedLeadId: first.leadId,
    });

    assert.equal(second.leadId, first.leadId);
    assert.equal(fake.leads.length, 1);
    assert.equal(fake.count("GET", /\/Leads\/search$/), searchesBefore, "no search needed");
    assert.equal(fake.count("POST", /\/Leads\/upsert$/), 1);
    assert.equal(fake.leads[0].Company, "Verma Textiles", "existing company kept");
    assert.equal(fake.notes.length, 1, "changed details preserved as a note");
    assert.match(fake.notes[0].content, /Company: Verma Textiles Pvt Ltd/);
  });
});

test("a linked Lead deleted in Zoho falls back to matching by email", async () => {
  await withFake(async (fake) => {
    const result = await pushLeadToZoho({
      customer: makeCustomer(),
      target: LEAD_SOURCE_FREE,
      submissionRef: "GSA_L3",
      linkedLeadId: "4199999999999",
    });
    assert.equal(fake.leads.length, 1);
    assert.equal(result.leadId, fake.leads[0].id);
  });
});

test("missing Lead Source picklist values are reported instead of writing an invalid Lead", async () => {
  await withFake(
    async (fake) => {
      const errors = mock.method(console, "error", () => undefined);
      try {
        await rejectsWithCode(
          pushLeadToZoho({ customer: makeCustomer(), target: LEAD_SOURCE_PAID, submissionRef: "GSA_4" }),
          "LEAD_SOURCE_NOT_IN_PICKLIST",
          true
        );
      } finally {
        errors.mock.restore();
      }
      assert.equal(fake.count("POST", /\/Leads\/upsert$/), 0);
      assert.equal(fake.count("PUT", /\/Leads\//), 0);
    },
    (fake) => {
      fake.picklist = ["Advertisement", "Growth Audit Free"];
    }
  );
});

// --- Error handling ----------------------------------------------------------

test("rate limits, outages, timeouts and network errors are retryable", async () => {
  const cases: [Parameters<FakeZoho["fail"]>[2], string][] = [
    [{ kind: "response", status: 429, body: { code: "TOO_MANY_REQUESTS" } }, "RATE_LIMITED"],
    [{ kind: "response", status: 503 }, "ZOHO_HTTP_503"],
    [{ kind: "timeout" }, "TIMEOUT"],
    [{ kind: "network" }, "NETWORK_ERROR"],
  ];
  for (const [fault, code] of cases) {
    await withFake(async (fake) => {
      fake.fail("POST", "/crm/v8/Leads/upsert", fault);
      await rejectsWithCode(
        pushLeadToZoho({ customer: makeCustomer(), target: LEAD_SOURCE_FREE, submissionRef: "GSA_5" }),
        code,
        true
      );
    });
  }
});

test("Zoho validation errors are permanent and name the rejected field", async () => {
  await withFake(async (fake) => {
    fake.fail("POST", "/crm/v8/Leads/upsert", {
      kind: "response",
      status: 400,
      body: { data: [{ code: "INVALID_DATA", details: { api_name: "Email" }, status: "error" }] },
    });
    await rejectsWithCode(
      pushLeadToZoho({ customer: makeCustomer(), target: LEAD_SOURCE_FREE, submissionRef: "GSA_6" }),
      "INVALID_DATA:Email",
      false
    );
  });
});

test("a stored Lead that no longer exists is flagged rather than silently re-created", async () => {
  await withFake(async (fake) => {
    await rejectsWithCode(
      pushLeadToZoho({
        customer: makeCustomer(),
        target: LEAD_SOURCE_PAID,
        submissionRef: "GSA_7",
        known: { leadId: "4199999999999", leadSource: LEAD_SOURCE_FREE },
      }),
      "LEAD_NOT_FOUND",
      false
    );
    assert.equal(fake.leads.length, 0);
  });
});

// --- Secret protection -------------------------------------------------------

test("OAuth failures never expose client secret or refresh token in errors or logs", async () => {
  await withFake(
    async () => {
      const logged: string[] = [];
      const capture = (...args: unknown[]) => {
        logged.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
      };
      const spies = (["log", "info", "warn", "error"] as const).map((level) => mock.method(console, level, capture));
      let thrown: unknown;
      try {
        await pushLeadToZoho({ customer: makeCustomer(), target: LEAD_SOURCE_FREE, submissionRef: "GSA_8" });
      } catch (error) {
        thrown = error;
      } finally {
        for (const spy of spies) spy.mock.restore();
      }

      assert.ok(thrown instanceof ZohoError);
      assert.equal(thrown.code, "OAUTH_invalid_client");
      const surface = [thrown.message, thrown.stack ?? "", ...logged].join("\n");
      for (const secret of Object.values(TEST_SECRETS)) {
        assert.equal(surface.includes(secret), false, "secret leaked");
      }
    },
    (fake) => {
      fake.tokenError = "invalid_client";
    }
  );
});

test("Zoho credentials are server-only and never referenced by client code", () => {
  const example = readFileSync(".env.example", "utf8");
  assert.equal(/NEXT_PUBLIC_[A-Z_]*ZOHO/.test(example), false);
  assert.match(example, /^ZOHO_CLIENT_SECRET=$/m);

  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry)) files.push(full);
    }
  };
  walk("src");
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    if (!/^["']use client["']/m.test(source)) continue;
    assert.equal(/lib\/zoho|ZOHO_/.test(source), false, `${file} must not reference Zoho`);
  }
});
