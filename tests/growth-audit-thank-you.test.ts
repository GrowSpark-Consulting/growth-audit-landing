import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import nextConfig from "../next.config";
import GrowthAuditThankYouPage from "../src/app/(thank-you)/growth-audit/thank-you/page";
import { submitFreeRequest } from "../src/lib/free-submit-client";
import { decideHostRouting, FREE_HOST, PAID_HOST } from "../src/lib/host-routing";

const render = (element: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(element);

// --- Thank-You Page Content & Style Checks -------------------------------------------

test("thank-you page renders approved heading, description, and REQUEST RECEIVED status label", () => {
  const html = render(createElement(GrowthAuditThankYouPage));

  assert.match(html, /<h1>Thank you for contacting Grow Spark Consulting!<\/h1>/);
  assert.match(
    html,
    /<p>Your Growth Audit request has been received successfully\. Our team will review your details and contact you to discuss the next steps for your business\.<\/p>/
  );
  assert.match(html, /<div class="eyebrow">REQUEST RECEIVED<\/div>/);
  assert.match(html, /<div class="check" aria-hidden="true">✓<\/div>/);
});

test("thank-you page contains absolutely no pricing or payment-related elements", () => {
  const html = render(createElement(GrowthAuditThankYouPage));

  // No ₹999, no ₹10,000, no price summary, no payment claims
  assert.doesNotMatch(html, /₹999/);
  assert.doesNotMatch(html, /₹10,?000/);
  assert.doesNotMatch(html, /price-summary/i);
  assert.doesNotMatch(html, /Payment confirmed/i);
  assert.doesNotMatch(html, /PayU/i);
  assert.doesNotMatch(html, /checkout/i);
  assert.doesNotMatch(html, /payment/i);
  assert.doesNotMatch(html, /purchased/i);
});

test("thank-you page displays the updated 3-step 'What happens next' section", () => {
  const html = render(createElement(GrowthAuditThankYouPage));

  assert.match(html, /<h2>What happens next<\/h2>/);
  // Step 1
  assert.match(html, /<h3>Save Grow Spark to your contacts<\/h3>/);
  assert.match(html, /<p>Download our contact details so you can easily recognize our calls and messages\.<\/p>/);
  // Step 2
  assert.match(html, /<h3>Our team will contact you<\/h3>/);
  assert.match(
    html,
    /<p>We(?:'|&#x27;)ll review your Growth Audit enquiry and get in touch to understand your business goals and challenges\.<\/p>/
  );
  // Step 3
  assert.match(html, /<h3>Discuss your growth opportunities<\/h3>/);
  assert.match(html, /<p>We(?:'|&#x27;)ll explain the next steps based on the information you submitted\.<\/p>/);
});

test("thank-you page includes the '＋ Save Grow Spark Contact' button with direct VCF download link", () => {
  const html = render(createElement(GrowthAuditThankYouPage));

  assert.match(
    html,
    /<a class="save-button" href="\/growspark-contact\.vcf" download="growspark-contact\.vcf">[\s\S]*?＋ Save Grow Spark Contact[\s\S]*?<\/a>/
  );
});

test("thank-you page preserves dark header and footer with Grow Spark branding", () => {
  const html = render(createElement(GrowthAuditThankYouPage));

  assert.match(html, /<header class="top">/);
  assert.match(html, /<a class="brand" href="\/">[\s\S]*?Grow Spark Consulting[\s\S]*?<\/a>/);
  assert.match(html, /<footer>[\s\S]*?© 2026 Grow Spark Consulting[\s\S]*?growsparkconsulting\.com[\s\S]*?<\/footer>/);
});

// --- VCF File Validation -------------------------------------------------------------

test("public/growspark-contact.vcf exists and contains the correct Grow Spark contact information", () => {
  const vcfPath = join(process.cwd(), "public", "growspark-contact.vcf");
  const content = readFileSync(vcfPath, "utf-8");

  assert.match(content, /^BEGIN:VCARD/m);
  assert.match(content, /^VERSION:3\.0/m);
  assert.match(content, /^FN:Grow Spark Consulting/m);
  assert.match(content, /^ORG:Grow Spark Consulting/m);
  assert.match(content, /^TEL;TYPE=WORK,VOICE:\+916381461106/m);
  assert.match(content, /^EMAIL;TYPE=WORK:admin@growsparkconsulting\.com/m);
  assert.match(content, /^URL:https:\/\/www\.growsparkconsulting\.com\//m);
  assert.match(content, /^END:VCARD/m);
});

test("next.config.ts configures text/vcard; charset=utf-8 header for /growspark-contact.vcf", async () => {
  assert.ok(typeof nextConfig.headers === "function");
  const headersConfig = await nextConfig.headers();
  const vcfHeaderRule = headersConfig.find((rule: { source: string }) => rule.source === "/growspark-contact.vcf");

  assert.ok(vcfHeaderRule, "Header rule for /growspark-contact.vcf must be defined");
  const contentType = vcfHeaderRule.headers.find(
    (h: { key: string; value: string }) => h.key.toLowerCase() === "content-type"
  );
  assert.ok(contentType, "Content-Type header must be present");
  assert.match(contentType.value, /text\/vcard/);
  assert.match(contentType.value, /charset=utf-8/i);
});

// --- Routing & Redirect Checks -------------------------------------------------------

test("/growth-audit/thank-you is accessible on free host and paid host", () => {
  assert.deepEqual(decideHostRouting(FREE_HOST, "/growth-audit/thank-you"), { action: "next" });
  assert.deepEqual(decideHostRouting(PAID_HOST, "/growth-audit/thank-you"), { action: "next" });
  assert.deepEqual(decideHostRouting("localhost:3000", "/growth-audit/thank-you"), { action: "next" });
});

test("LeadForm free variant triggers redirect only on successful submission", async () => {
  // Successful response returns ok: true
  const replySuccess = (async () => Response.json({ ok: true, eventId: "FREE_123" }, { status: 200 })) as typeof fetch;
  const outcomeSuccess = await submitFreeRequest({ name: "Test" }, replySuccess);
  assert.equal(outcomeSuccess.ok, true);

  // Failed response returns ok: false
  const replyError = (async () =>
    Response.json({ ok: false, error: "Validation failed" }, { status: 400 })) as typeof fetch;
  const outcomeError = await submitFreeRequest({ name: "Test" }, replyError);
  assert.equal(outcomeError.ok, false);
});
