import type { CustomerData } from "./orders";

export const LEAD_SOURCE_FREE = "Growth Audit Free";
export const LEAD_SOURCE_PAID = "Growth Audit Paid";
export type ZohoLeadSource = typeof LEAD_SOURCE_FREE | typeof LEAD_SOURCE_PAID;

const REQUEST_TIMEOUT_MS = 8_000;
const TOKEN_EXPIRY_SKEW_MS = 60_000;
const PICKLIST_CACHE_MS = 10 * 60_000;
// Standard Zoho Leads field limits; longer names are preserved in Description.
const FIRST_NAME_MAX = 40;
const LAST_NAME_MAX = 80;
const ACCOUNTS_HOST = /^accounts\.zoho(cloud)?\.[a-z]{2,3}(\.[a-z]{2})?$/;
const API_HOST = /^(www\.)?zohoapis\.[a-z]{2,3}(\.[a-z]{2})?$/;
const SEARCH_FIELDS = "First_Name,Last_Name,Email,Mobile,Company,Website,Description,Lead_Source";

/** Error whose message is a sanitized code that is safe to log and persist. */
export class ZohoError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, retryable: boolean) {
    const safeCode = code.replace(/[^A-Za-z0-9_:.-]/g, "_").slice(0, 80) || "UNKNOWN";
    super(safeCode);
    this.name = "ZohoError";
    this.code = safeCode;
    this.retryable = retryable;
  }
}

export interface ZohoConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  accountsUrl: string;
  apiVersion: string;
}

function isZohoOrigin(value: string, hostPattern: RegExp): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      hostPattern.test(url.hostname) &&
      url.pathname === "/" &&
      !url.search &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

export function getZohoConfig(): ZohoConfig {
  const clientId = process.env.ZOHO_CLIENT_ID?.trim() ?? "";
  const clientSecret = process.env.ZOHO_CLIENT_SECRET?.trim() ?? "";
  const refreshToken = process.env.ZOHO_REFRESH_TOKEN?.trim() ?? "";
  const accountsUrl = (process.env.ZOHO_ACCOUNTS_URL?.trim() ?? "").replace(/\/+$/, "");
  const apiVersion = process.env.ZOHO_API_VERSION?.trim() || "v8";

  if (!clientId || !clientSecret || !refreshToken || !accountsUrl) {
    throw new ZohoError("ZOHO_NOT_CONFIGURED", true);
  }
  if (!isZohoOrigin(accountsUrl, ACCOUNTS_HOST)) {
    throw new ZohoError("ZOHO_ACCOUNTS_URL_INVALID", true);
  }
  if (!/^v\d{1,2}$/.test(apiVersion)) {
    throw new ZohoError("ZOHO_API_VERSION_INVALID", true);
  }

  return {
    clientId,
    clientSecret,
    refreshToken,
    accountsUrl: new URL(accountsUrl).origin,
    apiVersion,
  };
}

export function isZohoConfigured(): boolean {
  try {
    getZohoConfig();
    return true;
  } catch {
    return false;
  }
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getString(value: unknown, key: string): string | undefined {
  if (!isObject(value)) return undefined;
  const field = value[key];
  return typeof field === "string" && field.length > 0 ? field : undefined;
}

function getNumber(value: unknown, key: string): number | undefined {
  if (!isObject(value)) return undefined;
  const field = value[key];
  return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}

async function send(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    throw new ZohoError(name === "TimeoutError" || name === "AbortError" ? "TIMEOUT" : "NETWORK_ERROR", true);
  }
}

async function readJson(response: Response): Promise<unknown> {
  if (response.status === 204) return null;
  const text = await response.text().catch(() => "");
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

interface AccessToken {
  accessToken: string;
  apiDomain: string;
  expiresAt: number;
}

let cachedToken: AccessToken | null = null;
let pendingToken: Promise<AccessToken> | null = null;
let cachedLeadSources: { values: Map<string, string>; expiresAt: number } | null = null;

export function resetZohoCaches(): void {
  cachedToken = null;
  pendingToken = null;
  cachedLeadSources = null;
}

async function requestAccessToken(): Promise<AccessToken> {
  const config = getZohoConfig();
  const response = await send(`${config.accountsUrl}/oauth/v2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: config.refreshToken,
    }),
  });
  const json = await readJson(response);
  const oauthError = getString(json, "error");
  if (!response.ok || oauthError) {
    throw new ZohoError(`OAUTH_${oauthError ?? `HTTP_${response.status}`}`, true);
  }

  const accessToken = getString(json, "access_token");
  const apiDomain = getString(json, "api_domain");
  const expiresInSeconds = getNumber(json, "expires_in") ?? 3600;
  // Never send the access token to a host that is not a Zoho API domain.
  if (!accessToken || !apiDomain || !isZohoOrigin(`${apiDomain.replace(/\/+$/, "")}/`, API_HOST)) {
    throw new ZohoError("OAUTH_INVALID_TOKEN_RESPONSE", true);
  }

  return {
    accessToken,
    apiDomain: new URL(apiDomain).origin,
    expiresAt: Date.now() + Math.max(expiresInSeconds * 1000 - TOKEN_EXPIRY_SKEW_MS, 30_000),
  };
}

/** Returns a cached access token, sharing one refresh across concurrent callers
 * because Zoho rate-limits token generation per refresh token. */
export async function getZohoAccessToken(): Promise<AccessToken> {
  if (cachedToken && cachedToken.expiresAt > Date.now()) return cachedToken;
  if (!pendingToken) {
    pendingToken = requestAccessToken()
      .then((token) => {
        cachedToken = token;
        return token;
      })
      .finally(() => {
        pendingToken = null;
      });
  }
  return pendingToken;
}

async function zohoApi(
  method: "GET" | "POST" | "PUT",
  path: string,
  body?: unknown,
  allowAuthRetry = true
): Promise<{ status: number; json: unknown }> {
  const config = getZohoConfig();
  const token = await getZohoAccessToken();
  const response = await send(`${token.apiDomain}/crm/${config.apiVersion}${path}`, {
    method,
    headers: {
      Authorization: `Zoho-oauthtoken ${token.accessToken}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await readJson(response);
  const code = getString(json, "code");

  if (response.status === 401) {
    if (cachedToken?.accessToken === token.accessToken) cachedToken = null;
    if (allowAuthRetry && code !== "OAUTH_SCOPE_MISMATCH") {
      return zohoApi(method, path, body, false);
    }
    throw new ZohoError(`AUTH_${code ?? "FAILED"}`, true);
  }
  if (response.status === 403) throw new ZohoError(`FORBIDDEN_${code ?? "NO_PERMISSION"}`, true);
  if (response.status === 429) throw new ZohoError("RATE_LIMITED", true);
  if (response.status >= 500) throw new ZohoError(`ZOHO_HTTP_${response.status}`, true);

  return { status: response.status, json };
}

function firstRecord(json: unknown): JsonObject | null {
  const data = isObject(json) ? json.data : undefined;
  return Array.isArray(data) && isObject(data[0]) ? data[0] : null;
}

function describeFailure(record: JsonObject | null, json: unknown, status: number): string {
  const code = getString(record, "code") ?? getString(json, "code") ?? `HTTP_${status}`;
  const apiName = getString(record?.details, "api_name");
  return apiName ? `${code}:${apiName}` : code;
}

function recordFailure(record: JsonObject | null, json: unknown, status: number): ZohoError {
  // Record-level codes (INVALID_DATA, MANDATORY_NOT_FOUND, ...) reject this
  // payload and will not succeed on retry; anything else is treated as transient.
  return new ZohoError(describeFailure(record, json, status), !getString(record, "code"));
}

export interface ZohoLeadFields {
  First_Name?: string;
  Last_Name: string;
  Email: string;
  Mobile: string;
  Company: string;
  Website?: string;
  Description: string;
  Lead_Source: string;
}

export interface ZohoLeadSnapshot {
  id: string;
  firstName?: string;
  mobile?: string;
  company?: string;
  website?: string;
  description?: string;
  leadSource?: string;
}

export interface ZohoFieldMetadata {
  apiName: string;
  dataType?: string;
  length?: number;
  picklist: { display: string; actual: string }[];
}

function toLeadSnapshot(lead: JsonObject): ZohoLeadSnapshot | null {
  const id = getString(lead, "id");
  if (!id) return null;
  return {
    id,
    firstName: getString(lead, "First_Name"),
    mobile: getString(lead, "Mobile"),
    company: getString(lead, "Company"),
    website: getString(lead, "Website"),
    description: getString(lead, "Description"),
    leadSource: getString(lead, "Lead_Source"),
  };
}

/** Zoho's search index trails new and edited records by about a minute, so a
 * miss here does not prove no Lead exists. */
export async function findLeadsByEmail(email: string): Promise<ZohoLeadSnapshot[]> {
  const query = new URLSearchParams({ email, fields: SEARCH_FIELDS });
  const { status, json } = await zohoApi("GET", `/Leads/search?${query}`);
  if (status === 204) return [];
  if (status !== 200) throw new ZohoError(`SEARCH_${describeFailure(null, json, status)}`, true);

  const data = isObject(json) && Array.isArray(json.data) ? json.data : [];
  return data.filter(isObject).flatMap((lead) => toLeadSnapshot(lead) ?? []);
}

/** Reads a Lead directly by ID (not subject to search-index delay); null if it no longer exists. */
export async function getLeadById(leadId: string): Promise<ZohoLeadSnapshot | null> {
  const query = new URLSearchParams({ fields: SEARCH_FIELDS });
  const { status, json } = await zohoApi("GET", `/Leads/${encodeURIComponent(leadId)}?${query}`);
  if (status === 200) {
    const record = firstRecord(json);
    return record ? toLeadSnapshot(record) : null;
  }
  if (status === 204 || status === 404 || getString(firstRecord(json), "code") === "INVALID_DATA") {
    return null;
  }
  throw new ZohoError(`GET_${describeFailure(firstRecord(json), json, status)}`, true);
}

/** Inserts a Lead, or updates the one Zoho's own duplicate check finds by Email. */
export async function upsertLead(fields: ZohoLeadFields): Promise<string> {
  const { status, json } = await zohoApi("POST", "/Leads/upsert", {
    data: [fields],
    duplicate_check_fields: ["Email"],
  });
  const record = firstRecord(json);
  const id = getString(record?.details, "id");
  if ((status === 200 || status === 201) && getString(record, "code") === "SUCCESS" && id && /^\d+$/.test(id)) {
    return id;
  }
  throw recordFailure(record, json, status);
}

export async function updateLead(leadId: string, fields: Partial<ZohoLeadFields>): Promise<void> {
  const { status, json } = await zohoApi("PUT", `/Leads/${encodeURIComponent(leadId)}`, { data: [fields] });
  const record = firstRecord(json);
  if (status === 200 && getString(record, "code") === "SUCCESS") return;
  // A converted or deleted Lead must be reviewed manually instead of re-created.
  if (status === 404 || describeFailure(record, json, status) === "INVALID_DATA:id") {
    throw new ZohoError("LEAD_NOT_FOUND", false);
  }
  throw recordFailure(record, json, status);
}

export async function addLeadNote(leadId: string, title: string, content: string): Promise<void> {
  const { status, json } = await zohoApi("POST", `/Leads/${encodeURIComponent(leadId)}/Notes`, {
    data: [{ Note_Title: title, Note_Content: content }],
  });
  const record = firstRecord(json);
  if ((status === 200 || status === 201) && getString(record, "code") === "SUCCESS") return;
  throw new ZohoError(`NOTE_${describeFailure(record, json, status)}`, true);
}

export async function fetchLeadFieldMetadata(): Promise<ZohoFieldMetadata[]> {
  const { status, json } = await zohoApi("GET", "/settings/fields?module=Leads");
  const fields = isObject(json) && Array.isArray(json.fields) ? json.fields : null;
  if (status !== 200 || !fields) {
    throw new ZohoError(`FIELDS_${describeFailure(null, json, status)}`, true);
  }
  return fields.filter(isObject).map((field) => ({
    apiName: getString(field, "api_name") ?? "",
    dataType: getString(field, "data_type"),
    length: getNumber(field, "length"),
    picklist: (Array.isArray(field.pick_list_values) ? field.pick_list_values : [])
      .filter(isObject)
      .map((value) => {
        const display = getString(value, "display_value") ?? getString(value, "actual_value") ?? "";
        return { display, actual: getString(value, "actual_value") ?? display };
      })
      .filter((value) => value.display.length > 0),
  }));
}

/** Maps both display and actual Lead_Source picklist labels to the actual value. */
async function getLeadSourcePicklist(): Promise<Map<string, string>> {
  if (cachedLeadSources && cachedLeadSources.expiresAt > Date.now()) {
    return cachedLeadSources.values;
  }
  const fields = await fetchLeadFieldMetadata();
  const values = new Map<string, string>();
  for (const option of fields.find((field) => field.apiName === "Lead_Source")?.picklist ?? []) {
    values.set(option.display, option.actual);
    values.set(option.actual, option.actual);
  }
  cachedLeadSources = { values, expiresAt: Date.now() + PICKLIST_CACHE_MS };
  return values;
}

export function splitFullName(fullName: string): {
  firstName?: string;
  lastName: string;
  truncated: boolean;
} {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  const lastName = parts[parts.length - 1] ?? fullName.trim();
  const firstName = parts.slice(0, -1).join(" ");
  return {
    firstName: firstName ? firstName.slice(0, FIRST_NAME_MAX) : undefined,
    lastName: lastName.slice(0, LAST_NAME_MAX),
    truncated: firstName.length > FIRST_NAME_MAX || lastName.length > LAST_NAME_MAX,
  };
}

export function buildLeadDescription(
  details: Partial<Pick<CustomerData, "team" | "industry" | "revenue" | "businessProblem">>,
  fullName?: string
): string {
  // Format agreed with the sales team; Zoho Free edition has no custom fields.
  const profile = [
    details.team ? `Team Size: ${details.team}` : "",
    details.industry ? `Industry: ${details.industry}` : "",
  ]
    .filter(Boolean)
    .join(" | ");
  const sentences: string[] = [];
  if (profile || details.revenue) {
    const revenue = details.revenue
      ? `${profile ? " with the" : "The"} annual revenue of ${details.revenue}`
      : "";
    sentences.push(`${profile}${revenue}.`);
  }
  if (details.businessProblem) sentences.push(`Challenge mentioned: ${details.businessProblem}`);
  const text = sentences.join(" ");
  return fullName ? `${text}\nFull name: ${fullName}` : text;
}

export function normalizePhone(phone: string): string {
  return phone.replace(/[\s\-()]/g, "");
}

export function mapCustomerToZohoLead(customer: CustomerData, leadSourceValue: string): ZohoLeadFields {
  const name = splitFullName(customer.name);
  return {
    ...(name.firstName ? { First_Name: name.firstName } : {}),
    Last_Name: name.lastName,
    Email: customer.email,
    Mobile: normalizePhone(customer.phone),
    Company: customer.company,
    ...(customer.website ? { Website: customer.website } : {}),
    Description: buildLeadDescription(customer, name.truncated ? customer.name.trim() : undefined),
    Lead_Source: leadSourceValue,
  };
}

export interface PushLeadInput {
  customer: CustomerData;
  target: ZohoLeadSource;
  submissionRef: string;
  known?: { leadId?: string; leadSource?: ZohoLeadSource };
  /** Lead already created for an earlier submission with the same email. */
  linkedLeadId?: string;
  payment?: { amount: number; currency: string; payuId?: string };
}

export interface PushLeadResult {
  leadId: string;
  leadSource: ZohoLeadSource;
}

async function addNoteSafely(leadId: string, title: string, content: string): Promise<void> {
  try {
    await addLeadNote(leadId, title, content);
  } catch (error) {
    console.warn("[ZOHO_SYNC] Lead note could not be attached.", {
      leadId,
      code: error instanceof ZohoError ? error.code : "UNEXPECTED_ERROR",
    });
  }
}

function paymentNote(input: PushLeadInput): string {
  const lines = [
    "Growth Audit payment verified by PayU.",
    `Amount: ${input.payment?.currency ?? "INR"} ${(input.payment?.amount ?? 0).toFixed(2)}`,
    `Submission reference: ${input.submissionRef}`,
  ];
  if (input.payment?.payuId) lines.push(`PayU payment ID: ${input.payment.payuId}`);
  return lines.join("\n");
}

function submissionNote(input: PushLeadInput, previousLeadSource?: string): string {
  const { customer } = input;
  const lines = [
    `Growth Audit form submission (reference ${input.submissionRef}).`,
    `Name: ${customer.name}`,
    `Email: ${customer.email}`,
    `Phone: ${customer.phone}`,
    `Company: ${customer.company}`,
  ];
  if (customer.website) lines.push(`Website: ${customer.website}`);
  lines.push(buildLeadDescription(customer));
  if (previousLeadSource) lines.push(`Previous Lead Source: ${previousLeadSource}`);
  return lines.join("\n");
}

async function mergeIntoExistingLead(
  existing: ZohoLeadSnapshot,
  input: PushLeadInput,
  picklist: Map<string, string>
): Promise<PushLeadResult> {
  const paidValue = picklist.get(LEAD_SOURCE_PAID) ?? LEAD_SOURCE_PAID;
  const existingValue = existing.leadSource ? picklist.get(existing.leadSource) ?? existing.leadSource : undefined;
  // Never downgrade a Lead that has already paid.
  const effective: ZohoLeadSource =
    input.target === LEAD_SOURCE_PAID || existingValue === paidValue ? LEAD_SOURCE_PAID : LEAD_SOURCE_FREE;
  const desired = mapCustomerToZohoLead(input.customer, picklist.get(effective) ?? effective);

  // Existing CRM data wins: only Lead_Source is managed here, other fields are
  // filled when empty, and the full new submission is preserved as a Note.
  const patch: Partial<ZohoLeadFields> = {};
  if (existingValue !== desired.Lead_Source) patch.Lead_Source = desired.Lead_Source;
  if (!existing.firstName && desired.First_Name) patch.First_Name = desired.First_Name;
  if (!existing.mobile) patch.Mobile = desired.Mobile;
  if (!existing.company) patch.Company = desired.Company;
  if (!existing.website && desired.Website) patch.Website = desired.Website;
  if (!existing.description) patch.Description = desired.Description;

  if (Object.keys(patch).length > 0) await updateLead(existing.id, patch);

  const submissionDiffers =
    existing.mobile !== desired.Mobile ||
    existing.company !== desired.Company ||
    (existing.website ?? "") !== (desired.Website ?? "") ||
    existing.description !== desired.Description;
  if (submissionDiffers) {
    await addNoteSafely(
      existing.id,
      "Growth Audit form submission",
      submissionNote(input, patch.Lead_Source ? existing.leadSource : undefined)
    );
  }
  if (input.target === LEAD_SOURCE_PAID) {
    await addNoteSafely(existing.id, "Growth Audit payment confirmed", paymentNote(input));
  }
  return { leadId: existing.id, leadSource: effective };
}

async function findPreferredLead(email: string, picklist: Map<string, string>): Promise<ZohoLeadSnapshot | null> {
  const leads = await findLeadsByEmail(email);
  if (leads.length > 1) {
    console.warn("[ZOHO_SYNC] Multiple Leads share the submitted email; using the Growth Audit match.", {
      matches: leads.length,
    });
  }
  const ours = new Set([LEAD_SOURCE_PAID, LEAD_SOURCE_FREE].map((value) => picklist.get(value) ?? value));
  const rank = (lead: ZohoLeadSnapshot) => {
    const value = lead.leadSource ? picklist.get(lead.leadSource) ?? lead.leadSource : "";
    if (value === (picklist.get(LEAD_SOURCE_PAID) ?? LEAD_SOURCE_PAID)) return 0;
    return ours.has(value) ? 1 : 2;
  };
  return [...leads].sort((a, b) => rank(a) - rank(b))[0] ?? null;
}

/** Creates or updates the Zoho Lead for one submission without creating
 * duplicates. Order of matching: this order's stored Lead ID, the Lead of an
 * earlier submission with the same email, a Zoho email search, and finally an
 * upsert keyed on Email for Leads too new to appear in search. */
export async function pushLeadToZoho(input: PushLeadInput): Promise<PushLeadResult> {
  const picklist = await getLeadSourcePicklist();
  const targetValue = picklist.get(input.target);
  if (!targetValue) {
    console.error("[ZOHO_SYNC] Lead Source picklist is missing a required value.", {
      value: input.target,
    });
    throw new ZohoError("LEAD_SOURCE_NOT_IN_PICKLIST", true);
  }

  const knownId = input.known?.leadId;
  if (knownId) {
    if (input.target === LEAD_SOURCE_PAID && input.known?.leadSource !== LEAD_SOURCE_PAID) {
      await updateLead(knownId, { Lead_Source: targetValue });
      await addNoteSafely(knownId, "Growth Audit payment confirmed", paymentNote(input));
      return { leadId: knownId, leadSource: LEAD_SOURCE_PAID };
    }
    return { leadId: knownId, leadSource: input.known?.leadSource ?? input.target };
  }

  if (input.linkedLeadId) {
    const linked = await getLeadById(input.linkedLeadId);
    if (linked) return mergeIntoExistingLead(linked, input, picklist);
  }

  const existing = await findPreferredLead(input.customer.email, picklist);
  if (existing) return mergeIntoExistingLead(existing, input, picklist);

  const leadId = await upsertLead(mapCustomerToZohoLead(input.customer, targetValue));
  if (input.target === LEAD_SOURCE_PAID) {
    await addNoteSafely(leadId, "Growth Audit payment confirmed", paymentNote(input));
  }
  return { leadId, leadSource: input.target };
}
