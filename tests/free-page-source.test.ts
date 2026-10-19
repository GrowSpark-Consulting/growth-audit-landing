import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import { LEAD_SOURCE_FREE, LEAD_SOURCE_PAID, pushLeadToZoho, type PushLeadInput } from "../src/lib/zoho";
import { FakeZoho, installFakeZoho, makeCustomer } from "./helpers/fake-zoho";

let fake: FakeZoho;
let restore: () => void;

// A Lead created by the free landing page: Lead Source "Growth Audit Free" (Zoho Free edition
// cannot add a separate picklist value), told apart by its "Submitted via the free landing page" Note.
beforeEach(() => {
  fake = new FakeZoho();
  restore = installFakeZoho(fake);
  fake.leads.push({
    id: "570000000012345",
    Email: "asha@vermatextiles.example",
    Last_Name: "Verma",
    Lead_Source: LEAD_SOURCE_FREE,
  });
  fake.settleSearchIndex();
});

afterEach(() => restore());

const input = (target: PushLeadInput["target"]): PushLeadInput => ({
  customer: makeCustomer(),
  target,
  submissionRef: "GSA_TEST_1",
});

test("an abandoned or failed paid checkout leaves a free-page Lead as 'Growth Audit Free'", async () => {
  const result = await pushLeadToZoho(input(LEAD_SOURCE_FREE));
  assert.equal(result.leadId, "570000000012345");
  assert.equal(fake.leads.length, 1);
  assert.equal(fake.leads[0].Lead_Source, LEAD_SOURCE_FREE);
  const puts = fake.requests.filter((request) => request.method === "PUT");
  for (const put of puts) {
    const fields = (put.body as { data: Record<string, unknown>[] }).data[0];
    assert.equal("Lead_Source" in fields, false, "Lead Source is not rewritten");
  }
});

test("a repeated unpaid checkout for the same applicant still leaves the source alone", async () => {
  await pushLeadToZoho(input(LEAD_SOURCE_FREE));
  await pushLeadToZoho({ ...input(LEAD_SOURCE_FREE), submissionRef: "GSA_TEST_2" });
  assert.equal(fake.leads.length, 1);
  assert.equal(fake.leads[0].Lead_Source, LEAD_SOURCE_FREE);
});

test("a server-verified payment still upgrades the Lead to 'Growth Audit Paid'", async () => {
  const result = await pushLeadToZoho({
    ...input(LEAD_SOURCE_PAID),
    payment: { amount: 999, currency: "INR", payuId: "403993715531077182" },
  });
  assert.equal(result.leadSource, LEAD_SOURCE_PAID);
  assert.equal(fake.leads.length, 1);
  assert.equal(fake.leads[0].Lead_Source, LEAD_SOURCE_PAID);
});

test("an unpaid checkout still tags a brand-new Lead 'Growth Audit Free' (paid-page behaviour unchanged)", async () => {
  const fresh = makeCustomer({ email: "new@example.com" });
  await pushLeadToZoho({ ...input(LEAD_SOURCE_FREE), customer: fresh });
  const created = fake.leads.find((lead) => lead.Email === "new@example.com");
  assert.equal(created?.Lead_Source, LEAD_SOURCE_FREE);
  assert.equal(fake.notes.length, 0, "paid-page Leads get no free-page note");
});
