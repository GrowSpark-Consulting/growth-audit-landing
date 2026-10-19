import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import {
  LEAD_SOURCE_FREE,
  LEAD_SOURCE_FREE_PAGE,
  LEAD_SOURCE_PAID,
  pushLeadToZoho,
  type PushLeadInput,
} from "../src/lib/zoho";
import { FakeZoho, installFakeZoho, makeCustomer } from "./helpers/fake-zoho";

let fake: FakeZoho;
let restore: () => void;

beforeEach(() => {
  fake = new FakeZoho();
  fake.picklist.push(LEAD_SOURCE_FREE_PAGE);
  restore = installFakeZoho(fake);
  fake.leads.push({
    id: "570000000012345",
    Email: "asha@vermatextiles.example",
    Last_Name: "Verma",
    Lead_Source: LEAD_SOURCE_FREE_PAGE,
  });
  fake.settleSearchIndex();
});

afterEach(() => restore());

const input = (target: PushLeadInput["target"]): PushLeadInput => ({
  customer: makeCustomer(),
  target,
  submissionRef: "GSA_TEST_1",
});

test("an abandoned or failed paid checkout does not overwrite 'Growth Audit Free Page'", async () => {
  const result = await pushLeadToZoho(input(LEAD_SOURCE_FREE));
  assert.equal(result.leadId, "570000000012345");
  assert.equal(fake.leads.length, 1);
  assert.equal(fake.leads[0].Lead_Source, LEAD_SOURCE_FREE_PAGE);
});

test("a repeated unpaid checkout for the same applicant still leaves the source alone", async () => {
  await pushLeadToZoho(input(LEAD_SOURCE_FREE));
  await pushLeadToZoho({ ...input(LEAD_SOURCE_FREE), submissionRef: "GSA_TEST_2" });
  assert.equal(fake.leads.length, 1);
  assert.equal(fake.leads[0].Lead_Source, LEAD_SOURCE_FREE_PAGE);
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
});
