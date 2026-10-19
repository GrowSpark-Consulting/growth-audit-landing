import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { afterEach, beforeEach } from "node:test";
import {
  buildDedupeKey,
  buildPayloadHash,
  DEDUPE_WINDOW,
  deliverFreeEmails,
  processFreeSubmission,
  retryFreeEmails,
  type FreeEmailKind,
  type FreeSubmissionDependencies,
  type FreeSubmissionDocument,
  type FreeSubmissionStore,
} from "../src/lib/free-submissions";
import { sendFreeApplicantConfirmationEmail, sendFreeTeamNotificationEmail } from "../src/lib/email";
import {
  FREE_PAGE_NOTE_TITLE,
  isZohoConfigured,
  LEAD_SOURCE_FREE,
  LEAD_SOURCE_PAID,
  pushFreePageLeadToZoho,
} from "../src/lib/zoho";
import type { CustomerData } from "../src/lib/orders";
import { FakeZoho, installFakeZoho, makeCustomer } from "./helpers/fake-zoho";

/** In-memory equivalent of the Mongo store, with the same claim/lease semantics. */
class MemoryStore implements FreeSubmissionStore {
  docs = new Map<string, FreeSubmissionDocument>();

  /** Set to make the next saveZohoSuccess calls throw (simulates MongoDB failing after Zoho succeeded). */
  failSaveSuccess = 0;
  failMarkSent = 0;
  private counter = 0;

  async upsert(customer: CustomerData, now: Date) {
    const payloadHash = buildPayloadHash(customer);
    const dedupeKey = buildDedupeKey(payloadHash, now);
    const existing = [...this.docs.values()].find(
      (d) => d.payloadHash === payloadHash && d.createdAt.getTime() >= now.getTime() - DEDUPE_WINDOW
    );
    if (existing) return structuredClone(existing);
    const doc: FreeSubmissionDocument = {
      submissionId: `FREE_TEST_${++this.counter}`,
      payloadHash,
      dedupeKey,
      customer,
      zoho: { attempts: 0 },
      createdAt: now,
      updatedAt: now,
    };
    this.docs.set(doc.submissionId, doc);
    return structuredClone(doc);
  }
  private doc(id: string) {
    const doc = this.docs.get(id);
    assert.ok(doc);
    return doc;
  }
  async findLinkedLeadId(email: string, excludeSubmissionId: string) {
    const linked = [...this.docs.values()]
      .filter((d) => d.customer.email === email && d.submissionId !== excludeSubmissionId && d.zoho?.leadId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
    return linked?.zoho?.leadId ?? null;
  }
  async get(id: string) {
    const doc = this.docs.get(id);
    return doc ? structuredClone(doc) : null;
  }
  async claimZoho(id: string, now: Date) {
    const doc = this.doc(id);
    if (doc.zoho?.leadId) return null;
    if (doc.zoho?.lockedUntil && doc.zoho.lockedUntil > now) return null;
    doc.zoho = { attempts: 0, ...doc.zoho, lockedUntil: new Date(now.getTime() + 90_000) };
    doc.zoho.attempts += 1;
    return structuredClone(doc);
  }
  async saveZohoSuccess(id: string, leadId: string, now: Date) {
    if (this.failSaveSuccess > 0) {
      this.failSaveSuccess -= 1;
      throw new Error("mongo down");
    }
    const doc = this.doc(id);
    doc.zoho = { attempts: doc.zoho?.attempts ?? 0, leadId, syncedAt: now };
  }
  async saveZohoFailure(id: string, errorCode: string) {
    const doc = this.doc(id);
    doc.zoho = { attempts: doc.zoho?.attempts ?? 0, lastError: errorCode };
  }
  async claimEmail(id: string, kind: FreeEmailKind, now: Date) {
    const doc = this.doc(id);
    const sent = kind === "applicant" ? doc.applicantEmailSentAt : doc.teamEmailSentAt;
    const claimed = kind === "applicant" ? doc.applicantEmailClaimedAt : doc.teamEmailClaimedAt;
    if (!doc.zoho?.leadId || sent) return false;
    if (claimed && claimed.getTime() > now.getTime() - 120_000) return false;
    if (kind === "applicant") doc.applicantEmailClaimedAt = now;
    else doc.teamEmailClaimedAt = now;
    return true;
  }
  async markEmailSent(id: string, kind: FreeEmailKind, now: Date) {
    if (this.failMarkSent > 0) {
      this.failMarkSent -= 1;
      throw new Error("mongo down");
    }
    const doc = this.doc(id);
    if (kind === "applicant") doc.applicantEmailSentAt = now;
    else doc.teamEmailSentAt = now;
  }
  async releaseEmail(id: string, kind: FreeEmailKind) {
    const doc = this.doc(id);
    if (kind === "applicant") delete doc.applicantEmailClaimedAt;
    else delete doc.teamEmailClaimedAt;
  }
  async findWithUnsentEmails(limit: number) {
    return [...this.docs.values()]
      .filter((d) => d.zoho?.leadId && (!d.applicantEmailSentAt || !d.teamEmailSentAt))
      .slice(0, limit)
      .map((d) => structuredClone(d));
  }
}

let fake: FakeZoho;
let restore: () => void;
let store: MemoryStore;
let applicantEmails: string[];
let teamEmails: string[];
let applicantOk = true;
let teamOk = true;
let clock = new Date("2026-10-19T10:00:00.000Z");

function deps(overrides: Partial<FreeSubmissionDependencies> = {}): FreeSubmissionDependencies {
  return {
    store,
    isZohoConfigured,
    pushLead: pushFreePageLeadToZoho,
    sendApplicantEmail: async (s) => {
      if (applicantOk) applicantEmails.push(s.submissionId);
      return applicantOk;
    },
    sendTeamEmail: async (s) => {
      if (teamOk) teamEmails.push(s.submissionId);
      return teamOk;
    },
    sleep: async () => undefined,
    now: () => clock,
    ...overrides,
  };
}

beforeEach(() => {
  fake = new FakeZoho();
  restore = installFakeZoho(fake);
  store = new MemoryStore();
  applicantEmails = [];
  teamEmails = [];
  applicantOk = true;
  teamOk = true;
  clock = new Date("2026-10-19T10:00:00.000Z");
});

afterEach(() => restore());

test("a free submission creates one 'Growth Audit Free' Lead marked as coming from the free page", async () => {
  const result = await processFreeSubmission(makeCustomer(), deps());
  assert.equal(result.ok, true);
  assert.equal(fake.leads.length, 1);
  const lead = fake.leads[0];
  assert.equal(lead.Lead_Source, "Growth Audit Free");
  assert.equal(lead.Email, "asha@vermatextiles.example");
  assert.equal(lead.Company, "Verma Textiles");
  assert.equal(lead.Mobile, "+919876543210");
  assert.match(String(lead.Description), /Team Size: 16-30/);

  assert.equal(fake.notes.length, 1);
  assert.equal(fake.notes[0].leadId, lead.id);
  assert.equal(fake.notes[0].title, "Submitted via the free landing page");
  assert.match(fake.notes[0].content, /^Submitted via the free landing page \(reference FREE_TEST_1\)\./);
});

test("a failed free-page marker note does not fail a submission whose Lead was created", async () => {
  fake.fail("POST", /\/Notes$/, { kind: "response", status: 500, body: { code: "INTERNAL_ERROR" } });
  const result = await processFreeSubmission(makeCustomer(), deps());
  assert.equal(result.ok, true);
  assert.equal(fake.leads.length, 1);
  assert.equal(fake.notes.length, 0);
  assert.equal(applicantEmails.length, 1);
  assert.equal(teamEmails.length, 1);
});

test("emails go out only after Zoho confirms the Lead, once each", async () => {
  const order: string[] = [];
  const result = await processFreeSubmission(
    makeCustomer(),
    deps({
      pushLead: async (input) => {
        const pushed = await pushFreePageLeadToZoho(input);
        order.push("zoho");
        return pushed;
      },
      sendApplicantEmail: async () => (order.push("applicant"), true),
      sendTeamEmail: async () => (order.push("team"), true),
    })
  );
  assert.equal(result.ok, true);
  assert.equal(order[0], "zoho");
  assert.deepEqual([...order.slice(1)].sort(), ["applicant", "team"]);
});

test("a Zoho failure returns an error, sends no emails, and a retry creates exactly one Lead", async () => {
  fake.fail("POST", "/crm/v8/Leads/upsert", { kind: "response", status: 500, body: { code: "INTERNAL_ERROR" } });
  const first = await processFreeSubmission(makeCustomer(), deps());
  assert.deepEqual(first, { ok: false, status: 502, error: "crm_unavailable" });
  assert.equal(fake.leads.length, 0);
  assert.equal(applicantEmails.length + teamEmails.length, 0);

  const second = await processFreeSubmission(makeCustomer(), deps());
  assert.equal(second.ok, true);
  assert.equal(fake.leads.length, 1);
  assert.equal(applicantEmails.length, 1);
  assert.equal(teamEmails.length, 1);
});

test("a missing 'Growth Audit Free' picklist value fails safely without creating a Lead", async () => {
  fake.picklist = fake.picklist.filter((value) => value !== LEAD_SOURCE_FREE);
  const result = await processFreeSubmission(makeCustomer(), deps());
  assert.equal(result.ok, false);
  assert.equal(fake.leads.length, 0);
  assert.equal(applicantEmails.length + teamEmails.length, 0);
});

test("missing Zoho credentials are reported without a record, a Lead or an email", async () => {
  const result = await processFreeSubmission(makeCustomer(), deps({ isZohoConfigured: () => false }));
  assert.deepEqual(result, { ok: false, status: 503, error: "not_configured" });
  assert.equal(store.docs.size, 0);
  assert.equal(applicantEmails.length + teamEmails.length, 0);
});

test("repeated and concurrent submissions create one Lead and send each email once", async () => {
  const results = await Promise.all([
    processFreeSubmission(makeCustomer(), deps()),
    processFreeSubmission(makeCustomer(), deps()),
    processFreeSubmission(makeCustomer(), deps()),
  ]);
  const again = await processFreeSubmission(makeCustomer(), deps());
  assert.ok(again.ok);
  assert.equal(fake.leads.length, 1);
  assert.equal(store.docs.size, 1);
  assert.equal(applicantEmails.length, 1);
  assert.equal(teamEmails.length, 1);
  // Every call either succeeded or was told to retry; none created extra data.
  for (const result of results) assert.ok(result.ok || result.status === 409);
});

test("an email failure keeps the submission successful and is recovered later without a second Lead", async () => {
  teamOk = false;
  const result = await processFreeSubmission(makeCustomer(), deps());
  assert.equal(result.ok, true);
  assert.equal(applicantEmails.length, 1);
  assert.equal(teamEmails.length, 0);

  teamOk = true;
  const recovered = await retryFreeEmails(deps());
  assert.equal(recovered.processed, 1);
  assert.equal(teamEmails.length, 1);
  assert.equal(applicantEmails.length, 1);
  assert.equal(fake.leads.length, 1);
  assert.equal((await retryFreeEmails(deps())).processed, 0);
});

test("an existing paid Lead keeps its source; the submission is attached as a Note", async () => {
  fake.leads.push({ id: "570000000099999", Email: "asha@vermatextiles.example", Last_Name: "Verma", Lead_Source: LEAD_SOURCE_PAID });
  fake.settleSearchIndex();
  const result = await processFreeSubmission(makeCustomer(), deps());
  assert.equal(result.ok, true);
  assert.equal(fake.leads.length, 1);
  assert.equal(fake.leads[0].Lead_Source, LEAD_SOURCE_PAID);
  assert.ok(fake.notes.some((note) => note.leadId === "570000000099999"));
});

test("an unsent email is not claimed twice by concurrent deliveries", async () => {
  await processFreeSubmission(makeCustomer(), deps({ sendApplicantEmail: async () => false, sendTeamEmail: async () => false }));
  const [doc] = [...store.docs.values()];
  clock = new Date(clock.getTime() + 10 * 60_000);
  await Promise.all([deliverFreeEmails(doc.submissionId, deps()), deliverFreeEmails(doc.submissionId, deps())]);
  assert.equal(applicantEmails.length, 1);
  assert.equal(teamEmails.length, 1);
});

test("the free workflow never contacts the payment gateway or creates an order", async () => {
  await processFreeSubmission(makeCustomer(), deps());
  const hosts = new Set(fake.requests.map((request) => request.url.hostname));
  assert.deepEqual([...hosts].sort(), ["accounts.zoho.in", "www.zohoapis.in"]);

  for (const file of ["src/lib/free-submissions.ts", "src/app/api/free-submit/route.ts", "src/app/(free)/free/page.tsx"]) {
    const source = readFileSync(file, "utf8");
    assert.doesNotMatch(source, /payu|createOrder|getOrdersCollection|api\/payment|initiate/i, file);
  }
});

// ---- Emails -----------------------------------------------------------------

const realFetch = globalThis.fetch;
const realKey = process.env.RESEND_API_KEY;

test("free emails contain no payment wording and are escaped", async () => {
  process.env.RESEND_API_KEY = "re_test_key";
  const sent: { body: Record<string, unknown>; key: string | null }[] = [];
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    sent.push({ body: JSON.parse(String(init?.body)), key: new Headers(init?.headers).get("Idempotency-Key") });
    return Response.json({ id: "email_1" });
  }) as typeof fetch;
  try {
    const submission = {
      submissionId: "FREE_TEST_001",
      customer: makeCustomer({ name: "Asha <b>Verma</b>" }),
    };
    assert.equal(await sendFreeApplicantConfirmationEmail(submission), true);
    assert.equal(await sendFreeTeamNotificationEmail(submission), true);

    assert.equal(sent.length, 2);
    assert.equal(sent[0].body.to, "asha@vermatextiles.example");
    assert.equal(sent[0].key, "free-audit/applicant/FREE_TEST_001");
    assert.deepEqual(sent[1].body.to, [
      "raja@growsparkconsulting.com",
      "pragadeesh@growsparkconsulting.com",
      "susshinder@growsparkconsulting.com",
    ]);
    for (const { body } of sent) {
      // The applicant’s own revenue range (e.g. ₹1-2 crore) is legitimate form data, not a price.
      const content = `${body.subject} ${body.html} ${body.text}`.split(submission.customer.revenue).join("");
      assert.doesNotMatch(content, /payment|paid|₹|checkout|amount|transaction|invoice|PayU|\bINR\b/i);
      assert.doesNotMatch(String(body.html), /<b>Verma<\/b>/);
    }
  } finally {
    globalThis.fetch = realFetch;
    if (realKey === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = realKey;
  }
});

// ---- Deduplication: retries vs genuine updates --------------------------------

test("an identical retry reuses the record; no second Lead, note or email", async () => {
  await processFreeSubmission(makeCustomer(), deps());
  clock = new Date(clock.getTime() + 60 * 60_000);
  const retry = await processFreeSubmission(makeCustomer({ name: "  ASHA RANI VERMA " }), deps());
  assert.ok(retry.ok);
  assert.equal(store.docs.size, 1);
  assert.equal(fake.leads.length, 1);
  assert.equal(fake.notes.length, 1, "only the first submission's free-page note");
  assert.equal(applicantEmails.length, 1);
  assert.equal(teamEmails.length, 1);
});

test("a genuine update within 24h is kept, linked to the same Lead, and the team is told", async () => {
  await processFreeSubmission(makeCustomer(), deps());
  const leadId = fake.leads[0].id;

  clock = new Date(clock.getTime() + 30 * 60_000);
  const update = await processFreeSubmission(
    makeCustomer({ company: "Verma Textiles Pvt Ltd", revenue: "₹2-3 crore", team: "31-75" }),
    deps()
  );
  assert.ok(update.ok);

  // A new record holds the new details; the Zoho Lead is the same one.
  assert.equal(store.docs.size, 2);
  const records = [...store.docs.values()];
  assert.equal(records[0].zoho?.leadId, leadId);
  assert.equal(records[1].zoho?.leadId, leadId);
  assert.equal(fake.leads.length, 1);
  assert.equal(fake.leads[0].Lead_Source, "Growth Audit Free");

  // The new details are preserved in the CRM as a Note on that Lead.
  const note = fake.notes.filter((n) => n.leadId === leadId).at(-1);
  assert.ok(note, "update is attached to the existing Lead");
  assert.equal(note.title, FREE_PAGE_NOTE_TITLE);
  assert.match(note.content, /Verma Textiles Pvt Ltd/);
  assert.match(note.content, /₹2-3 crore/);

  // Emails for the update go out once each.
  assert.equal(applicantEmails.length, 2);
  assert.equal(teamEmails.length, 2);
});

test("the update is associated by stored Lead ID even before Zoho search indexes the new Lead", async () => {
  await processFreeSubmission(makeCustomer(), deps());
  // The fake keeps a new Lead out of search results until settled, like real Zoho.
  const searchesBefore = fake.count("GET", /\/Leads\/search$/);
  await processFreeSubmission(makeCustomer({ company: "Verma Textiles Pvt Ltd" }), deps());
  assert.equal(fake.leads.length, 1);
  assert.equal(fake.count("GET", /\/Leads\/search$/), searchesBefore);
});

test("an identical submission after the 24h window is a new request, linked to the same Lead", async () => {
  await processFreeSubmission(makeCustomer(), deps());
  clock = new Date(clock.getTime() + DEDUPE_WINDOW + 60_000);
  await processFreeSubmission(makeCustomer(), deps());
  assert.equal(store.docs.size, 2);
  assert.equal(fake.leads.length, 1);
});

// ---- Failure and retry behaviour ----------------------------------------------

test("Zoho succeeds but MongoDB fails to record it: success is still reported, no duplicate Lead on retry", async () => {
  store.failSaveSuccess = 3;
  const first = await processFreeSubmission(makeCustomer(), deps());
  // The CRM has the Lead, so the applicant is not told it failed; emails wait for the record.
  assert.equal(first.ok, true);
  assert.equal(fake.leads.length, 1);
  assert.equal(applicantEmails.length + teamEmails.length, 0);
  assert.equal([...store.docs.values()][0].zoho?.leadId, undefined);

  // After the lease expires a retry reuses the same Lead, records it, then sends the emails.
  clock = new Date(clock.getTime() + 5 * 60_000);
  const retry = await processFreeSubmission(makeCustomer(), deps());
  assert.ok(retry.ok);
  assert.equal(fake.leads.length, 1);
  assert.equal([...store.docs.values()][0].zoho?.leadId, fake.leads[0].id);
  assert.equal(applicantEmails.length, 1);
  assert.equal(teamEmails.length, 1);
});

test("a transient MongoDB error while recording the Lead is retried and the emails still go out", async () => {
  store.failSaveSuccess = 1;
  const result = await processFreeSubmission(makeCustomer(), deps());
  assert.ok(result.ok);
  assert.equal(fake.leads.length, 1);
  assert.equal(applicantEmails.length, 1);
  assert.equal(teamEmails.length, 1);
});

test("MongoDB unavailable before anything is saved: nothing reaches Zoho or email", async () => {
  const broken = deps({
    store: Object.assign(Object.create(store), {
      upsert: async () => {
        throw new Error("mongo down");
      },
    }),
  });
  await assert.rejects(processFreeSubmission(makeCustomer(), broken), /mongo down/);
  assert.equal(fake.requests.length, 0);
  assert.equal(applicantEmails.length + teamEmails.length, 0);
});

test("a bookkeeping failure after a sent email does not fail the submission", async () => {
  store.failMarkSent = 2;
  const result = await processFreeSubmission(makeCustomer(), deps());
  assert.ok(result.ok);
  assert.equal(fake.leads.length, 1);
});

test("a failed email never reverses the saved Lead and both emails are retried independently", async () => {
  applicantOk = false;
  teamOk = false;
  const result = await processFreeSubmission(makeCustomer(), deps());
  assert.ok(result.ok);
  assert.equal(fake.leads.length, 1);

  applicantOk = true;
  await retryFreeEmails(deps());
  assert.equal(applicantEmails.length, 1);
  assert.equal(teamEmails.length, 0);
  teamOk = true;
  await retryFreeEmails(deps());
  assert.equal(teamEmails.length, 1);
  assert.equal(applicantEmails.length, 1);
});
