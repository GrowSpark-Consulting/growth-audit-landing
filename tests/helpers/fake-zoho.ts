import { mock } from "node:test";
import { resetZohoCaches } from "../../src/lib/zoho";
import type { CustomerData } from "../../src/lib/orders";

export const ACCOUNTS_URL = "https://accounts.zoho.in";
export const API_DOMAIN = "https://www.zohoapis.in";
export const TEST_SECRETS = {
  ZOHO_CLIENT_ID: "1000.TESTCLIENTID",
  ZOHO_CLIENT_SECRET: "test-client-secret-value-123",
  ZOHO_REFRESH_TOKEN: "1000.test-refresh-token-value-456",
};

export type FakeLead = { id: string } & Record<string, unknown>;

export interface FakeRequest {
  method: string;
  url: URL;
  headers: Headers;
  body: unknown;
}

type Fault =
  | { kind: "response"; status: number; body?: unknown }
  | { kind: "network" }
  | { kind: "timeout" }
  | { kind: "commit-then-timeout" };

interface FaultRule {
  method?: string;
  path: string | RegExp;
  fault: Fault;
  remaining: number;
}

function json(status: number, body: unknown): Response {
  if (status === 204) return new Response(null, { status });
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function timeoutError(): DOMException {
  return new DOMException("The operation was aborted due to timeout", "TimeoutError");
}

/** In-memory stand-in for the Zoho Accounts + CRM REST APIs used by the integration. */
export class FakeZoho {
  leads: FakeLead[] = [];
  notes: { leadId: string; title: string; content: string }[] = [];
  requests: FakeRequest[] = [];
  tokenRequests: URLSearchParams[] = [];
  picklist = ["Advertisement", "Web Download", "Growth Audit Free", "Growth Audit Paid"];
  tokenApiDomain = API_DOMAIN;
  tokenError: string | null = null;
  down = false;
  /** Leads written through the API, not yet visible to search (Zoho indexes with a delay). */
  private unindexed = new Set<string>();
  private validTokens = new Set<string>();
  private tokenCount = 0;
  private nextId = 1;
  private faults: FaultRule[] = [];

  fail(method: string | undefined, path: string | RegExp, fault: Fault, times = 1): void {
    this.faults.push({ method, path, fault, remaining: times });
  }

  expireAllTokens(): void {
    this.validTokens.clear();
  }

  settleSearchIndex(): void {
    this.unindexed.clear();
  }

  count(method: string, path: RegExp): number {
    return this.requests.filter((r) => r.method === method && path.test(r.url.pathname)).length;
  }

  readonly fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init.method ?? "GET").toUpperCase();
    const raw = init.body;
    const body =
      raw instanceof URLSearchParams ? raw : typeof raw === "string" ? (JSON.parse(raw) as unknown) : undefined;
    const request: FakeRequest = { method, url, headers: new Headers(init.headers), body };
    this.requests.push(request);

    if (this.down) throw new TypeError("fetch failed");
    const fault = this.takeFault(request);
    if (fault?.kind === "network") throw new TypeError("fetch failed");
    if (fault?.kind === "timeout") throw timeoutError();
    if (fault?.kind === "response") return json(fault.status, fault.body ?? {});
    const response = this.route(request);
    if (fault?.kind === "commit-then-timeout") throw timeoutError();
    return response;
  };

  private takeFault(request: FakeRequest): Fault | undefined {
    const rule = this.faults.find(
      (candidate) =>
        candidate.remaining > 0 &&
        (!candidate.method || candidate.method === request.method) &&
        (typeof candidate.path === "string"
          ? request.url.pathname === candidate.path
          : candidate.path.test(request.url.pathname))
    );
    if (!rule) return undefined;
    rule.remaining -= 1;
    return rule.fault;
  }

  private route({ method, url, headers, body }: FakeRequest): Response {
    if (url.origin === ACCOUNTS_URL && url.pathname === "/oauth/v2/token" && method === "POST") {
      this.tokenRequests.push(body as URLSearchParams);
      if (this.tokenError) return json(400, { error: this.tokenError });
      const token = `tok-${++this.tokenCount}`;
      this.validTokens.add(token);
      return json(200, {
        access_token: token,
        api_domain: this.tokenApiDomain,
        token_type: "Bearer",
        expires_in: 3600,
      });
    }
    if (url.origin !== API_DOMAIN) return json(404, { code: "UNKNOWN_HOST" });

    const token = (headers.get("authorization") ?? "").replace(/^Zoho-oauthtoken /, "");
    if (!this.validTokens.has(token)) {
      return json(401, { code: "INVALID_TOKEN", message: "invalid oauth token", status: "error" });
    }

    const path = url.pathname.replace(/^\/crm\/v8/, "");
    const records = (body as { data?: Record<string, unknown>[] } | undefined)?.data ?? [];

    if (method === "GET" && path === "/settings/fields") {
      return json(200, {
        fields: [
          ...["Last_Name", "First_Name", "Email", "Mobile", "Company", "Website", "Description"].map(
            (apiName) => ({ api_name: apiName, data_type: "text", length: 80 })
          ),
          {
            api_name: "Lead_Source",
            data_type: "picklist",
            pick_list_values: this.picklist.map((value) => ({ display_value: value, actual_value: value })),
          },
        ],
      });
    }

    if (method === "GET" && path === "/Leads/search") {
      const email = (url.searchParams.get("email") ?? "").toLowerCase();
      const matches = this.leads.filter(
        (lead) => !this.unindexed.has(lead.id) && String(lead.Email ?? "").toLowerCase() === email
      );
      return matches.length ? json(200, { data: matches.map((lead) => ({ ...lead })) }) : json(204, null);
    }

    if (method === "POST" && path === "/Leads/upsert") {
      const record = records[0] ?? {};
      if (!record.Last_Name) {
        return json(400, {
          data: [{ code: "MANDATORY_NOT_FOUND", details: { api_name: "Last_Name" }, status: "error" }],
        });
      }
      // Zoho's duplicate check reads the database directly, unlike search.
      const duplicate = this.leads.find((lead) => lead.Email === record.Email);
      if (duplicate) {
        Object.assign(duplicate, record);
        return json(200, {
          data: [{ code: "SUCCESS", action: "update", details: { id: duplicate.id }, status: "success" }],
        });
      }
      const id = `57000000000${String(this.nextId++).padStart(5, "0")}`;
      this.leads.push({ id, ...record });
      this.unindexed.add(id);
      return json(201, { data: [{ code: "SUCCESS", action: "insert", details: { id }, status: "success" }] });
    }

    const recordMatch = path.match(/^\/Leads\/(\d+)$/);
    if (method === "GET" && recordMatch) {
      const lead = this.leads.find((candidate) => candidate.id === recordMatch[1]);
      return lead ? json(200, { data: [{ ...lead }] }) : json(204, null);
    }

    const updateMatch = recordMatch;
    if (method === "PUT" && updateMatch) {
      const lead = this.leads.find((candidate) => candidate.id === updateMatch[1]);
      if (!lead) {
        return json(400, { data: [{ code: "INVALID_DATA", details: { api_name: "id" }, status: "error" }] });
      }
      Object.assign(lead, records[0] ?? {});
      return json(200, { data: [{ code: "SUCCESS", details: { id: lead.id }, status: "success" }] });
    }

    const noteMatch = path.match(/^\/Leads\/(\d+)\/Notes$/);
    if (method === "POST" && noteMatch) {
      const note = records[0] ?? {};
      this.notes.push({
        leadId: noteMatch[1],
        title: String(note.Note_Title ?? ""),
        content: String(note.Note_Content ?? ""),
      });
      return json(201, { data: [{ code: "SUCCESS", details: { id: "9001" }, status: "success" }] });
    }

    return json(400, { code: "INVALID_URL_PATTERN", status: "error" });
  }
}

/** Installs a FakeZoho as global fetch with Zoho env vars set; returns a restore function. */
export function installFakeZoho(fake: FakeZoho): () => void {
  const env = process.env as Record<string, string | undefined>;
  const keys = [...Object.keys(TEST_SECRETS), "ZOHO_ACCOUNTS_URL", "ZOHO_API_VERSION"];
  const previous = new Map(keys.map((key) => [key, env[key]]));
  Object.assign(env, TEST_SECRETS, { ZOHO_ACCOUNTS_URL: ACCOUNTS_URL });
  delete env.ZOHO_API_VERSION;
  resetZohoCaches();
  const fetchMock = mock.method(globalThis, "fetch", fake.fetch);

  return () => {
    fetchMock.mock.restore();
    resetZohoCaches();
    for (const [key, value] of previous) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
  };
}

export function makeCustomer(overrides: Partial<CustomerData> = {}): CustomerData {
  return {
    name: "Asha Rani Verma",
    phone: "+91 98765 43210",
    email: "asha@vermatextiles.example",
    company: "Verma Textiles",
    website: "https://vermatextiles.example",
    team: "16-30",
    industry: "Manufacturing",
    revenue: "₹1-2 crore",
    businessProblem: "Stuck at the same revenue for years",
    ...overrides,
  };
}
