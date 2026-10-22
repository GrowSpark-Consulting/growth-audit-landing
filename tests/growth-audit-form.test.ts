import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { MongoClient, type Collection, type Db } from "mongodb";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChallengeDetailsField } from "../src/components/landing/ChallengeDetailsField";
import { LeadForm } from "../src/components/landing/LeadForm";
import { sendFreeTeamNotificationEmail, sendTeamPaymentNotificationEmail } from "../src/lib/email";
import {
  buildLeadPayload,
  CHALLENGE_DETAILS_MAX,
  CITY_HTML_PATTERN,
  detailsAfterChallengeChange,
  isValidCity,
  needsChallengeDetails,
  normalizeCity,
  OTHER_CHALLENGE,
  REVENUES,
} from "../src/lib/form-options";
import { buildPayloadHash } from "../src/lib/free-submissions";
import {
  createOrder,
  FIXED_ORDER_AMOUNT,
  FIXED_ORDER_CURRENCY,
  FIXED_PRODUCT_NAME,
  validateCustomerInput,
  type CustomerData,
  type OrderDocument,
} from "../src/lib/orders";
import { buildLeadDescription, mapCustomerToZohoLead, pushLeadToZoho, LEAD_SOURCE_FREE } from "../src/lib/zoho";
import { FakeZoho, installFakeZoho, makeCustomer } from "./helpers/fake-zoho";

const EXPECTED_REVENUES = [
  "Below ₹50 lakh",
  "₹50 lakh-₹1 crore",
  "₹1-2 crore",
  "₹2-3 crore",
  "₹3-5 crore",
  "Above ₹5 crore",
];
const DESCRIPTION = "Our sales team depends entirely on the founder for every large deal.";

const render = (element: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(element);
const paidForm = () => render(createElement(LeadForm));
const freeForm = () => render(createElement(LeadForm, { variant: "free" }));
const selectOptions = (html: string, id: string) => {
  const select = html.match(new RegExp(`<select[^>]*id="${id}"[^>]*>([\\s\\S]*?)</select>`))?.[1] ?? "";
  return [...select.matchAll(/<option(?![^>]*disabled)[^>]*>([^<]*)<\/option>/g)].map((match) => match[1]);
};
const decode = (value: string) => value.replace(/&amp;/g, "&").replace(/&#x27;/g, "'");

function fullPayload(overrides: Record<string, string> = {}) {
  const formData = new FormData();
  const values: Record<string, string> = {
    name: "Asha Rani Verma",
    phone: "+91 98765 43210",
    email: "asha@vermatextiles.example",
    company: "Verma Textiles",
    website: "www.vermatextiles.example",
    city: "  Coimbatore ",
    team: "16-30",
    industry: "Manufacturing",
    revenue: "₹1-2 crore",
    businessProblem: OTHER_CHALLENGE,
    challengeDetails: `  ${DESCRIPTION}  `,
    ...overrides,
  };
  for (const [name, value] of Object.entries(values)) formData.set(name, value);
  return buildLeadPayload(formData);
}

const validate = (overrides: Record<string, unknown> = {}) =>
  validateCustomerInput({ ...fullPayload(), ...overrides } as Partial<CustomerData>);

// ---- Frontend ----------------------------------------------------------------------

test("1-2. Annual revenue offers exactly the six ranges, without 'Prefer to discuss'", () => {
  assert.deepEqual([...REVENUES], EXPECTED_REVENUES);
  for (const html of [paidForm(), freeForm()]) {
    assert.deepEqual(selectOptions(html, "revenue").map(decode), EXPECTED_REVENUES);
    assert.doesNotMatch(html, /Prefer to discuss/);
  }
});

test("3. the description box appears only for 'Another business challenge'", () => {
  assert.equal(needsChallengeDetails(OTHER_CHALLENGE), true);
  for (const other of ["Stuck at the same revenue for years", "My revenue is going down every year", ""]) {
    assert.equal(needsChallengeDetails(other), false);
  }
  // Nothing is chosen on first load, so the box is not rendered.
  assert.doesNotMatch(paidForm(), /<textarea/);

  const field = render(
    createElement(ChallengeDetailsField, { value: "", error: null, disabled: false, onChange: () => {}, onInvalid: () => {} })
  );
  assert.match(field, /<label for="challengeDetails">Please describe your business challenge \*<\/label>/);
  assert.match(field, /placeholder="Briefly describe your main business challenge\.\.\."/);
});

test("4. the description is required, with an inline message next to the field", () => {
  const empty = render(
    createElement(ChallengeDetailsField, { value: "", error: null, disabled: false, onChange: () => {}, onInvalid: () => {} })
  );
  assert.match(empty, /<textarea[^>]*required=""/);
  assert.doesNotMatch(empty, /role="alert"/);

  const withError = render(
    createElement(ChallengeDetailsField, {
      value: "",
      error: "Please describe your business challenge.",
      disabled: false,
      onChange: () => {},
      onInvalid: () => {},
    })
  );
  assert.match(withError, /aria-invalid="true"/);
  assert.match(withError, /role="alert">Please describe your business challenge\.<\/span>/);
});

test("5. choosing another challenge clears the description so it is never sent stale", () => {
  assert.equal(detailsAfterChallengeChange("Stuck at the same revenue for years", DESCRIPTION), "");
  assert.equal(detailsAfterChallengeChange(OTHER_CHALLENGE, DESCRIPTION), DESCRIPTION);
  // Even if a description is present in the form data, it is only sent with the matching choice.
  assert.equal(fullPayload({ businessProblem: "Stuck at the same revenue for years" }).challengeDetails, undefined);
  assert.equal(fullPayload().challengeDetails, `  ${DESCRIPTION}  `);
});

test("6. the description is capped at 300 characters with a live counter", () => {
  const renderWith = (value: string) =>
    render(createElement(ChallengeDetailsField, { value, error: null, disabled: false, onChange: () => {}, onInvalid: () => {} }));
  assert.equal(CHALLENGE_DETAILS_MAX, 300);
  assert.match(renderWith(""), /maxLength="300"/);
  assert.match(renderWith(""), /<span id="challengeDetails-count">0\/300<\/span>/);
  assert.match(renderWith("abc"), /<span id="challengeDetails-count">3\/300<\/span>/);
  assert.match(renderWith("x".repeat(300)), /<span id="challengeDetails-count">300\/300<\/span>/);
});

test("7-8. City accepts typed city names and enforces letters, trimming and length", () => {
  const html = paidForm();
  assert.match(html, /<label for="city">City \*<\/label>/);
  const input = html.match(/<input[^>]*id="city"[^>]*>/)?.[0] ?? "";
  assert.match(input, /required=""/);
  assert.match(input, /maxLength="100"/);
  assert.match(input, /placeholder="Enter your city"/);

  // Browsers compile `pattern` in v-mode (older ones in u-mode); both must accept and reject the same values.
  for (const flags of ["u", "v"]) {
    const pattern = new RegExp(`^(?:${CITY_HTML_PATTERN})$`, flags);
    for (const city of ["Coimbatore", " New Delhi ", "Kochi (Ernakulam)", "St. Thomas", "बेंगलुरु"]) {
      assert.equal(pattern.test(city), true, `${flags}: ${city}`);
    }
    for (const city of ["   ", "12345", "Pune 411001", "<b>"]) assert.equal(pattern.test(city), false, `${flags}: ${city}`);
  }

  assert.equal(normalizeCity("   Navi    Mumbai  "), "Navi Mumbai");
  assert.equal(isValidCity("Navi Mumbai"), true);
  assert.equal(isValidCity(""), false);
  assert.equal(isValidCity("A".repeat(101)), false);
  assert.equal(isValidCity("A".repeat(100)), true);
});

test("9. every previously required field is still required, and Website stays optional", () => {
  const html = paidForm();
  for (const id of ["name", "phone", "email", "company", "city", "team", "industry", "revenue", "businessProblem"]) {
    const element = html.match(new RegExp(`<(input|select)[^>]*id="${id}"[^>]*>`))?.[0] ?? "";
    assert.match(element, /required=""/, `${id} must be required`);
  }
  assert.doesNotMatch(html.match(/<input[^>]*id="website"[^>]*>/)?.[0] ?? "", /required/);
  // Free and paid forms still submit the same fields.
  const names = (form: string) => [...form.matchAll(/name="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(names(freeForm()), names(paidForm()));
  assert.deepEqual(names(paidForm()), [
    "name", "phone", "email", "company", "website", "city", "team", "industry", "revenue", "businessProblem",
  ]);
});

test("10. a complete, valid form produces a valid submission", () => {
  const result = validateCustomerInput(fullPayload() as Partial<CustomerData>);
  assert.equal(result.valid, true, result.errors.join(" "));
  assert.equal(result.data?.city, "Coimbatore");
  assert.equal(result.data?.challengeDetails, DESCRIPTION);
  assert.equal(result.data?.businessProblem, OTHER_CHALLENGE);
});

// ---- Backend --------------------------------------------------------------------------

test("11. revenue values outside the six ranges are rejected, including 'Prefer to discuss'", () => {
  for (const revenue of ["Prefer to discuss", "₹10 crore", ""]) {
    const result = validate({ revenue });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((error) => /revenue range/.test(error)));
  }
  for (const revenue of EXPECTED_REVENUES) assert.equal(validate({ revenue }).valid, true, revenue);
});

test("12. 'Another business challenge' without a description is rejected", () => {
  for (const challengeDetails of [undefined, "", "    ", "\n\n"]) {
    const result = validate({ challengeDetails });
    assert.equal(result.valid, false);
    assert.ok(result.errors.includes("Please describe your business challenge."));
  }
});

test("13. a valid description is trimmed and kept; one over 300 characters is rejected", () => {
  assert.equal(validate({ challengeDetails: "Line one\r\nLine two  " }).data?.challengeDetails, "Line one\nLine two");
  assert.equal(validate({ challengeDetails: "x".repeat(300) }).valid, true);
  const tooLong = validate({ challengeDetails: "x".repeat(301) });
  assert.equal(tooLong.valid, false);
  assert.ok(tooLong.errors.some((error) => /300 characters/.test(error)));
  // A description sent with any other challenge is dropped, not stored.
  const other = validate({ businessProblem: "Stuck at the same revenue for years", challengeDetails: "stale" });
  assert.equal(other.valid, true);
  assert.equal("challengeDetails" in (other.data ?? {}), false);
});

test("14. City is required, validated and stored with the submission", async () => {
  for (const city of [undefined, "", "   ", "123", "Pune 411001", "A".repeat(101)]) {
    const result = validate({ city });
    assert.equal(result.valid, false, String(city));
    assert.ok(result.errors.some((error) => /city/i.test(error)));
  }
  assert.equal(validate({ city: "  New   Delhi " }).data?.city, "New Delhi");

  const env = process.env as Record<string, string | undefined>;
  const previous = { NODE_ENV: env.NODE_ENV, MONGODB_URI: env.MONGODB_URI };
  const previousGlobalPromise = global._mongoClientPromise;
  env.NODE_ENV = "development";
  env.MONGODB_URI = "mongodb://127.0.0.1:27017/test";
  global._mongoClientPromise = undefined;
  const inserted: OrderDocument[] = [];
  const connectMock = mock.method(MongoClient.prototype, "connect", async function (this: MongoClient) {
    return this;
  });
  const dbMock = mock.method(MongoClient.prototype, "db", () => ({
    collection: () =>
      ({
        createIndex: async () => "ok",
        insertOne: async (doc: OrderDocument) => {
          inserted.push(doc);
          return { insertedId: "id" };
        },
      }) as unknown as Collection<OrderDocument>,
  }) as unknown as Db);
  try {
    await createOrder(validate().data!);
  } finally {
    connectMock.mock.restore();
    dbMock.mock.restore();
    global._mongoClientPromise = previousGlobalPromise;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
  }
  assert.equal(inserted[0].customer.city, "Coimbatore");
  assert.equal(inserted[0].customer.challengeDetails, DESCRIPTION);

  // A free-page resubmission with a different city is a new submission, not a retry.
  assert.notEqual(buildPayloadHash(makeCustomer()), buildPayloadHash(makeCustomer({ city: "Madurai" })));
});

test("15. records saved before this change (no city, old revenue) still map and email correctly", async () => {
  const legacy: CustomerData = {
    name: "Old Customer",
    phone: "9876543210",
    email: "old@example.com",
    company: "Legacy Co",
    team: "1-5",
    industry: "Other",
    revenue: "Prefer to discuss",
    businessProblem: OTHER_CHALLENGE,
  };
  const lead = mapCustomerToZohoLead(legacy, LEAD_SOURCE_FREE);
  assert.equal("City" in lead, false);
  assert.equal(
    lead.Description,
    "Team Size: 1-5 | Industry: Other with the annual revenue of Prefer to discuss. Challenge mentioned: Another business challenge"
  );
  const order: OrderDocument = {
    txnid: "GSA_OLD",
    amount: FIXED_ORDER_AMOUNT,
    currency: FIXED_ORDER_CURRENCY,
    productInfo: FIXED_PRODUCT_NAME,
    customer: legacy,
    status: "PAID",
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const sent = await captureEmail(() => sendTeamPaymentNotificationEmail(order));
  assert.match(sent.text, /City: -/);
  assert.doesNotMatch(sent.text, /Challenge description/);
});

// ---- Zoho CRM --------------------------------------------------------------------------

test("16-20. Zoho receives City in its own field and revenue plus the description in Description", () => {
  const customer = validate().data!;
  assert.deepEqual(mapCustomerToZohoLead(customer, "Growth Audit Free"), {
    First_Name: "Asha Rani",
    Last_Name: "Verma",
    Email: "asha@vermatextiles.example",
    Mobile: "+919876543210",
    Company: "Verma Textiles",
    Website: "https://www.vermatextiles.example",
    City: "Coimbatore",
    Description:
      "Team Size: 16-30 | Industry: Manufacturing with the annual revenue of ₹1-2 crore. " +
      `Challenge mentioned: Another business challenge. Challenge description: ${DESCRIPTION}`,
    Lead_Source: "Growth Audit Free",
  });
  // Without "Another business challenge" the Description keeps the agreed format exactly.
  assert.equal(
    buildLeadDescription({ team: "1-5", industry: "Other", revenue: "Above ₹5 crore", businessProblem: "Stuck at the same revenue for years" }),
    "Team Size: 1-5 | Industry: Other with the annual revenue of Above ₹5 crore. Challenge mentioned: Stuck at the same revenue for years"
  );
});

test("an existing Zoho Lead gets City only when its City is empty, and the full submission as a note", async () => {
  const fake = new FakeZoho();
  const restore = installFakeZoho(fake);
  try {
    fake.leads.push(
      { id: "4100000000010", Email: "empty@example.com", Last_Name: "Empty", Lead_Source: "Advertisement" },
      { id: "4100000000011", Email: "kept@example.com", Last_Name: "Kept", City: "Chennai", Lead_Source: "Advertisement" }
    );
    fake.settleSearchIndex();
    const customer = validate().data!;
    await pushLeadToZoho({ customer: { ...customer, email: "empty@example.com" }, target: LEAD_SOURCE_FREE, submissionRef: "GSA_A" });
    await pushLeadToZoho({ customer: { ...customer, email: "kept@example.com" }, target: LEAD_SOURCE_FREE, submissionRef: "GSA_B" });

    assert.equal(fake.leads[0].City, "Coimbatore", "empty City is filled");
    assert.equal(fake.leads[1].City, "Chennai", "existing City is not overwritten");
    const note = fake.notes.find((n) => n.leadId === "4100000000011")?.content ?? "";
    assert.match(note, /City: Coimbatore/);
    assert.match(note, new RegExp(`Challenge description: ${DESCRIPTION}`));
  } finally {
    restore();
  }
});

test("21-22. a Zoho failure is retryable and a retry with the new fields creates one Lead", async () => {
  const fake = new FakeZoho();
  const restore = installFakeZoho(fake);
  const warn = mock.method(console, "warn", () => undefined);
  try {
    const customer = validate().data!;
    fake.fail("POST", "/crm/v8/Leads/upsert", { kind: "commit-then-timeout" });
    await assert.rejects(
      pushLeadToZoho({ customer, target: LEAD_SOURCE_FREE, submissionRef: "GSA_R" }),
      (error: unknown) => (error as { code: string; retryable: boolean }).code === "TIMEOUT" && (error as { retryable: boolean }).retryable
    );
    const retried = await pushLeadToZoho({ customer, target: LEAD_SOURCE_FREE, submissionRef: "GSA_R" });
    assert.equal(fake.leads.length, 1);
    assert.equal(retried.leadId, fake.leads[0].id);
    assert.equal(fake.leads[0].City, "Coimbatore");
  } finally {
    warn.mock.restore();
    restore();
  }
});

// ---- Team emails -----------------------------------------------------------------------

async function captureEmail(send: () => Promise<boolean>) {
  const realFetch = globalThis.fetch;
  const realKey = process.env.RESEND_API_KEY;
  process.env.RESEND_API_KEY = "re_test_key";
  let body: { text: string; html: string } = { text: "", html: "" };
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    body = JSON.parse(String(init?.body));
    return Response.json({ id: "email_1" });
  }) as typeof fetch;
  try {
    assert.equal(await send(), true);
    return body;
  } finally {
    globalThis.fetch = realFetch;
    if (realKey === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = realKey;
  }
}

test("the team email shows City and the challenge description", async () => {
  const sent = await captureEmail(() =>
    sendFreeTeamNotificationEmail({ submissionId: "FREE_1", customer: validate().data! })
  );
  assert.match(sent.text, /City: Coimbatore/);
  assert.match(sent.text, new RegExp(`Challenge description: ${DESCRIPTION}`));
});
