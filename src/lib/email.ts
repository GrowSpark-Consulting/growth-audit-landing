import { Resend } from "resend";
import { FIXED_ORDER_AMOUNT, type OrderDocument } from "./orders";

const FROM_ADDRESS = "GrowSpark Consulting <noreply@growsparkconsulting.com>";
const TEAM_ADDRESSES = [
  "raja@growsparkconsulting.com",
  "pragadeesh@growsparkconsulting.com",
  "susshinder@growsparkconsulting.com",
];

const SEND_TIMEOUT_MS = 8000;

let client: Resend | null = null;

function getClient(): Resend | null {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return null;
  client ??= new Resend(apiKey);
  return client;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function challengeDescriptionRow(customer: OrderDocument["customer"]): [string, string][] {
  return customer.challengeDetails ? [["Challenge description", customer.challengeDetails]] : [];
}

function formatAmount(order: OrderDocument): string {
  return `₹${(order.amount ?? FIXED_ORDER_AMOUNT).toLocaleString("en-IN")}`;
}

/**
 * Resend dedupes a repeated key (same payload) for 24 hours, so a retry after a
 * crash that lost the "sent" record does not email twice within that window.
 */
export function paymentEmailIdempotencyKey(kind: "customer" | "team", txnid: string): string {
  return `payment-confirmation/${kind}/${txnid}`;
}

async function send(
  label: string,
  txnid: string,
  idempotencyKey: string,
  message: { to: string | string[]; subject: string; html: string; text: string }
): Promise<boolean> {
  try {
    const resend = getClient();
    if (!resend) {
      console.error(`[EMAIL] ${label} not sent for ${txnid}: RESEND_API_KEY is not configured.`);
      return false;
    }
    const { error } = await resend.emails.send(
      { from: FROM_ADDRESS, ...message },
      // Bound the wait so a hung Resend request cannot stall the PayU redirect. A
      // timed-out send is treated as failed and retried; the key prevents a duplicate.
      { idempotencyKey, signal: AbortSignal.timeout(SEND_TIMEOUT_MS) }
    );
    if (error) {
      console.error(`[EMAIL] ${label} failed for ${txnid}: ${error.name}: ${error.message}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(
      `[EMAIL] ${label} threw for ${txnid}: ${err instanceof Error ? err.message : "unknown error"}`
    );
    return false;
  }
}

/** Never throws. Returns true only if Resend accepted the message. */
export async function sendCustomerPaymentConfirmationEmail(
  order: OrderDocument
): Promise<boolean> {
  const { customer, txnid } = order;
  const amount = formatAmount(order);
  const text = [
    `Hi ${customer.name},`,
    "",
    `Thank you. We have received your payment of ${amount} for the Business Growth Audit.`,
    "",
    `Transaction reference: ${txnid}`,
    "",
    "What happens next: our team will contact you shortly to begin your audit.",
    "Please keep this reference handy in case you need to reach us.",
    "",
    "GrowSpark Consulting",
  ].join("\n");
  const html = `<div style="font-family:Arial,sans-serif;max-width:560px;color:#1a1a1a;line-height:1.5">
<p>Hi ${escapeHtml(customer.name)},</p>
<p>Thank you. We have received your payment of <strong>${escapeHtml(amount)}</strong> for the <strong>Business Growth Audit</strong>.</p>
<p>Transaction reference: <strong>${escapeHtml(txnid)}</strong></p>
<p><strong>What happens next:</strong> our team will contact you shortly to begin your audit. Please keep this reference handy in case you need to reach us.</p>
<p>GrowSpark Consulting</p>
</div>`;

  return send("Customer confirmation", txnid, paymentEmailIdempotencyKey("customer", txnid), {
    to: customer.email,
    subject: "Payment received - your Business Growth Audit",
    html,
    text,
  });
}

/** Never throws. Returns true only if Resend accepted the message. */
export async function sendTeamPaymentNotificationEmail(
  order: OrderDocument
): Promise<boolean> {
  const { customer, txnid } = order;
  const rows: [string, string][] = [
    ["Name", customer.name],
    ["Company", customer.company],
    ["City", customer.city ?? "-"],
    ["Phone", customer.phone],
    ["Email", customer.email],
    ["Amount", formatAmount(order)],
    ["Transaction ID", txnid],
    ["Team size", customer.team],
    ["Industry", customer.industry],
    ["Revenue", customer.revenue],
    ["Business challenge", customer.businessProblem],
    ...challengeDescriptionRow(customer),
  ];
  const text = ["New paid Business Growth Audit customer", "", ...rows.map(([k, v]) => `${k}: ${v}`)].join("\n");
  const html = `<div style="font-family:Arial,sans-serif;color:#1a1a1a">
<h2>New paid Business Growth Audit customer</h2>
<table cellpadding="6" style="border-collapse:collapse">
${rows
  .map(([k, v]) => `<tr><td style="font-weight:bold;vertical-align:top">${escapeHtml(k)}</td><td>${escapeHtml(v)}</td></tr>`)
  .join("\n")}
</table>
</div>`;

  return send("Team notification", txnid, paymentEmailIdempotencyKey("team", txnid), {
    to: TEAM_ADDRESSES,
    subject: `New paid audit: ${customer.name} (${customer.company})`,
    html,
    text,
  });
}

// ---- Free landing page emails (no payment details of any kind) ----------------

export interface FreeSubmissionEmailInput {
  submissionId: string;
  customer: OrderDocument["customer"];
}

export function freeEmailIdempotencyKey(kind: "applicant" | "team", submissionId: string): string {
  return `free-audit/${kind}/${submissionId}`;
}

/** Never throws. Returns true only if Resend accepted the message. */
export async function sendFreeApplicantConfirmationEmail(
  submission: FreeSubmissionEmailInput
): Promise<boolean> {
  const { customer, submissionId } = submission;
  const text = [
    `Hi ${customer.name},`,
    "",
    "Thank you. We have received your request for a Business Growth Audit.",
    "",
    "What happens next: our team will review your details and contact you shortly to discuss fit and next steps.",
    "",
    "GrowSpark Consulting",
  ].join("\n");
  const html = `<div style="font-family:Arial,sans-serif;max-width:560px;color:#1a1a1a;line-height:1.5">
<p>Hi ${escapeHtml(customer.name)},</p>
<p>Thank you. We have received your request for a <strong>Business Growth Audit</strong>.</p>
<p><strong>What happens next:</strong> our team will review your details and contact you shortly to discuss fit and next steps.</p>
<p>GrowSpark Consulting</p>
</div>`;

  return send("Free applicant confirmation", submissionId, freeEmailIdempotencyKey("applicant", submissionId), {
    to: customer.email,
    subject: "We received your Business Growth Audit request",
    html,
    text,
  });
}

/** Never throws. Returns true only if Resend accepted the message. */
export async function sendFreeTeamNotificationEmail(
  submission: FreeSubmissionEmailInput
): Promise<boolean> {
  const { customer, submissionId } = submission;
  const rows: [string, string][] = [
    ["Name", customer.name],
    ["Company", customer.company],
    ["City", customer.city ?? "-"],
    ["Phone", customer.phone],
    ["Email", customer.email],
    ["Website", customer.website ?? "-"],
    ["Team size", customer.team],
    ["Industry", customer.industry],
    ["Revenue", customer.revenue],
    ["Business challenge", customer.businessProblem],
    ...challengeDescriptionRow(customer),
    ["Submission reference", submissionId],
  ];
  const text = ["New free Business Growth Audit request", "", ...rows.map(([k, v]) => `${k}: ${v}`)].join("\n");
  const html = `<div style="font-family:Arial,sans-serif;color:#1a1a1a">
<h2>New free Business Growth Audit request</h2>
<table cellpadding="6" style="border-collapse:collapse">
${rows
  .map(([k, v]) => `<tr><td style="font-weight:bold;vertical-align:top">${escapeHtml(k)}</td><td>${escapeHtml(v)}</td></tr>`)
  .join("\n")}
</table>
</div>`;

  return send("Free team notification", submissionId, freeEmailIdempotencyKey("team", submissionId), {
    to: TEAM_ADDRESSES,
    subject: `New free audit request: ${customer.name} (${customer.company})`,
    html,
    text,
  });
}
