import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { MongoClient, type Db } from "mongodb";
import { buildConsentCookie, CONSENT_CHANGE_EVENT, parseConsent } from "../src/lib/consent";
import { submitFreeRequest } from "../src/lib/free-submit-client";
import {
  buildFreeLeadEvent,
  buildMetaUserData,
  buildPurchaseEvent,
  createMongoMetaDeliveryStore,
  getMetaCapiConfig,
  normalizePhoneForMeta,
  readMetaTrackingContext,
  sendFreeLeadConversion,
  sendMetaEvents,
  sendPurchaseConversion,
  type MetaCapiConfig,
  type MetaDeliveryDeps,
  type MetaDeliveryKind,
  type MetaServerEvent,
  type MetaTrackingContext,
} from "../src/lib/meta-capi";
import {
  AUDIT_CURRENCY,
  AUDIT_PRICE,
  setConsent,
  trackMetaEvent,
  type PixelEnvironment,
} from "../src/lib/meta-pixel";
import {
  createOrder,
  FIXED_ORDER_AMOUNT,
  FIXED_ORDER_CURRENCY,
  FIXED_PRODUCT_NAME,
  type OrderDocument,
} from "../src/lib/orders";
import { makeCustomer } from "./helpers/fake-zoho";

const PIXEL_ID = "123456789012345";
const TOKEN = "EAAB-test-access-token-do-not-log";

// ---- Fakes --------------------------------------------------------------------

function fakeBrowser(initialCookie = "", options: { storageThrows?: boolean } = {}) {
  const jar = new Map<string, string>();
  for (const part of initialCookie.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name) jar.set(name, rest.join("="));
  }
  const scripts: string[] = [];
  const cookieWrites: string[] = [];
  const emitted: [string, unknown][] = [];
  const stored = new Map<string, string>();
  const env: PixelEnvironment = {
    win: {},
    getCookie: () => [...jar].map(([name, value]) => `${name}=${value}`).join("; "),
    setCookie: (value) => {
      cookieWrites.push(value);
      const [pair, ...attributes] = value.split(";");
      const [name, ...rest] = pair.split("=");
      if (attributes.some((attribute) => /^max-age=0$/i.test(attribute.trim()))) jar.delete(name.trim());
      else jar.set(name.trim(), rest.join("="));
    },
    injectScript: (src) => scripts.push(src),
    isSecure: true,
    hostname: "growthaudit.growsparkconsulting.com",
    storage: options.storageThrows
      ? {
          getItem: () => {
            throw new Error("blocked");
          },
          setItem: () => {
            throw new Error("blocked");
          },
        }
      : { getItem: (key) => stored.get(key) ?? null, setItem: (key, value) => void stored.set(key, value) },
    emit: (name, detail) => emitted.push([name, detail]),
  };
  const calls = () => env.win.fbq?.queue ?? [];
  return { env, jar, scripts, cookieWrites, emitted, calls };
}

function paidOrder(overrides: Partial<OrderDocument> = {}): OrderDocument {
  return {
    txnid: "GSA_1792400000000_abcd1234",
    amount: FIXED_ORDER_AMOUNT,
    currency: FIXED_ORDER_CURRENCY,
    productInfo: FIXED_PRODUCT_NAME,
    customer: makeCustomer(),
    status: "PAID",
    tracking: { consent: "granted", fbp: "fb.1.1792400000000.123456789", clientIp: "203.0.113.5" },
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

const CONFIG: MetaCapiConfig = { pixelId: PIXEL_ID, accessToken: TOKEN, apiVersion: "v24.0" };

function memoryDelivery(sendResults: { ok: boolean }[] = []) {
  const claimed = new Set<string>();
  const sent = new Set<string>();
  const sentEvents: MetaServerEvent[] = [];
  const deps: MetaDeliveryDeps = {
    store: {
      async claim(kind: MetaDeliveryKind, id: string) {
        const key = `${kind}:${id}`;
        if (sent.has(key) || claimed.has(key)) return false;
        claimed.add(key);
        return true;
      },
      async markSent(kind, id) {
        sent.add(`${kind}:${id}`);
      },
      async release(kind, id) {
        claimed.delete(`${kind}:${id}`);
      },
    },
    config: () => CONFIG,
    send: async (events) => {
      const result = sendResults.shift() ?? { ok: true };
      if (result.ok) sentEvents.push(...events);
      return result.ok ? { ok: true } : { ok: false, error: "META_HTTP_500" };
    },
    now: () => new Date("2026-10-21T10:00:00.000Z"),
  };
  return { deps, sentEvents };
}

// ---- Consent --------------------------------------------------------------------

test("consent is read from the gs_consent cookie; anything else means no choice yet", () => {
  assert.equal(parseConsent("a=1; gs_consent=granted; b=2"), "granted");
  assert.equal(parseConsent("gs_consent=denied"), "denied");
  assert.equal(parseConsent("gs_consent=yes"), null);
  assert.equal(parseConsent(""), null);
  assert.equal(parseConsent(null), null);
  assert.equal(
    buildConsentCookie("granted", true),
    "gs_consent=granted; Path=/; Max-Age=15552000; SameSite=Lax; Secure"
  );
  assert.doesNotMatch(buildConsentCookie("denied", false), /Secure/);
});

// ---- Browser Pixel ----------------------------------------------------------------

test("the Pixel never loads or sends without consent", () => {
  for (const cookie of ["", "gs_consent=denied"]) {
    const browser = fakeBrowser(cookie);
    assert.equal(trackMetaEvent(browser.env, PIXEL_ID, "PageView", {}), false);
    assert.equal(browser.scripts.length, 0);
    assert.equal(browser.env.win.fbq, undefined);
  }
});

test("an invalid or missing Pixel ID disables tracking even with consent", () => {
  for (const pixelId of ["", "abc", "12345"]) {
    const browser = fakeBrowser("gs_consent=granted");
    assert.equal(trackMetaEvent(browser.env, pixelId, "PageView", {}), false);
    assert.equal(browser.scripts.length, 0);
  }
});

test("with consent the Pixel loads once and sends PageView tagged paid or free", () => {
  const browser = fakeBrowser("gs_consent=granted");
  assert.equal(trackMetaEvent(browser.env, PIXEL_ID, "PageView", { content_category: "free" }), true);
  assert.equal(trackMetaEvent(browser.env, PIXEL_ID, "ViewContent", {}), true);
  assert.deepEqual(browser.scripts, ["https://connect.facebook.net/en_US/fbevents.js"]);
  assert.deepEqual(browser.calls()[0], ["init", PIXEL_ID]);
  assert.deepEqual(browser.calls()[1], ["track", "PageView", { content_category: "free" }]);
});

test("Purchase fires once per order: a reloaded thank-you page does not repeat it", () => {
  const browser = fakeBrowser("gs_consent=granted");
  const params = { value: 999, currency: "INR", content_category: "paid" };
  assert.equal(trackMetaEvent(browser.env, PIXEL_ID, "Purchase", params, "GSA_1"), true);
  assert.equal(trackMetaEvent(browser.env, PIXEL_ID, "Purchase", params, "GSA_1"), false);
  assert.equal(trackMetaEvent(browser.env, PIXEL_ID, "Purchase", params, "GSA_2"), true);
  const purchases = browser.calls().filter((call) => call[1] === "Purchase");
  assert.deepEqual(purchases, [
    ["track", "Purchase", params, { eventID: "GSA_1" }],
    ["track", "Purchase", params, { eventID: "GSA_2" }],
  ]);
});

test("with storage blocked the event still carries its eventID so Meta can deduplicate", () => {
  const browser = fakeBrowser("gs_consent=granted", { storageThrows: true });
  assert.equal(trackMetaEvent(browser.env, PIXEL_ID, "Lead", {}, "FREE_1"), true);
  assert.deepEqual(browser.calls().at(-1), ["track", "Lead", {}, { eventID: "FREE_1" }]);
});

test("accepting mid-visit enables the Pixel; declining revokes it and removes Meta cookies", () => {
  const browser = fakeBrowser("_fbp=fb.1.1792400000000.123; _fbc=fb.1.1792400000000.abc");
  assert.equal(trackMetaEvent(browser.env, PIXEL_ID, "PageView", {}), false);

  setConsent(browser.env, "granted");
  assert.match(browser.cookieWrites.at(-1) ?? "", /^gs_consent=granted; .*Secure$/);
  assert.deepEqual(browser.emitted.at(-1), [CONSENT_CHANGE_EVENT, "granted"]);
  assert.equal(trackMetaEvent(browser.env, PIXEL_ID, "PageView", {}), true);

  setConsent(browser.env, "denied");
  assert.deepEqual(browser.calls().at(-1), ["consent", "revoke"]);
  assert.equal(browser.jar.has("_fbp"), false);
  assert.equal(browser.jar.has("_fbc"), false);
  assert.ok(browser.cookieWrites.some((write) => write.includes("Domain=.growsparkconsulting.com")));
  assert.equal(parseConsent(browser.env.getCookie()), "denied");
  assert.equal(trackMetaEvent(browser.env, PIXEL_ID, "Lead", {}, "FREE_9"), false);
});

test("the InitiateCheckout value matches the server-enforced checkout price", () => {
  assert.equal(AUDIT_PRICE, FIXED_ORDER_AMOUNT);
  assert.equal(AUDIT_CURRENCY, FIXED_ORDER_CURRENCY);
});

test("the free form passes the saved submission's event ID to the browser Lead event", async () => {
  const reply = (async () => Response.json({ ok: true, eventId: "FREE_1792400000000_ab12cd34" })) as typeof fetch;
  assert.deepEqual(await submitFreeRequest({}, reply), { ok: true, eventId: "FREE_1792400000000_ab12cd34" });
});

// ---- Server: consent and identifiers -------------------------------------------------

test("server events are only prepared for visitors who accepted cookies", () => {
  assert.equal(readMetaTrackingContext(new Headers()), null);
  assert.equal(readMetaTrackingContext(new Headers({ cookie: "gs_consent=denied; _fbp=fb.1.1.1" })), null);

  const context = readMetaTrackingContext(
    new Headers({
      cookie: "gs_consent=granted; _fbp=fb.1.1792400000000.123456789; _fbc=fb.1.1792400000000.IwAR2abc-DEF_9",
      "x-forwarded-for": "203.0.113.5, 10.0.0.1",
      "user-agent": "Mozilla/5.0 Test",
      referer: "https://growthaudit-free.growsparkconsulting.com/?utm_source=fb&email=asha%40example.in",
    })
  );
  assert.deepEqual(context, {
    consent: "granted",
    fbp: "fb.1.1792400000000.123456789",
    fbc: "fb.1.1792400000000.IwAR2abc-DEF_9",
    clientIp: "203.0.113.5",
    userAgent: "Mozilla/5.0 Test",
    eventSourceUrl: "https://growthaudit-free.growsparkconsulting.com/",
  });

  const junk = readMetaTrackingContext(
    new Headers({ cookie: "gs_consent=granted; _fbp=<script>", "x-forwarded-for": "not-an-ip" })
  );
  assert.deepEqual(junk, { consent: "granted" });
});

test("customer identifiers are normalized and SHA-256 hashed; IP, user agent and browser IDs are not", () => {
  assert.equal(normalizePhoneForMeta("+91 98765 43210"), "919876543210");
  assert.equal(normalizePhoneForMeta("09876543210"), "919876543210");
  assert.equal(normalizePhoneForMeta("9876543210"), "919876543210");

  const context: MetaTrackingContext = {
    consent: "granted",
    clientIp: "203.0.113.5",
    userAgent: "Mozilla/5.0 Test",
    fbp: "fb.1.1792400000000.123456789",
  };
  assert.deepEqual(buildMetaUserData(makeCustomer({ email: " Asha@VermaTextiles.example " }), context), {
    em: ["aed32477ef7871bd627217eb621004f9a5b28c63d2568db4cee0716f9827f763"],
    ph: ["92b5072176e723878b5e06ff3ca61898e4eb74e8c46642a0f2db800b17364ab0"],
    fn: ["b22b87fd8ac6c19a6ed4ffd686a6130f5972367a9520a1b8aef33b8b5b5e3340"],
    ln: ["649a026370a6b0dc0f3ea43a1d4bed529fb19c51f14c3f9ce83f5662af733426"],
    client_ip_address: "203.0.113.5",
    client_user_agent: "Mozilla/5.0 Test",
    fbp: "fb.1.1792400000000.123456789",
  });
});

test("Purchase and Lead events carry the dedup ID, the funnel and no raw personal data", () => {
  const now = new Date("2026-10-21T10:00:00.000Z");
  const order = paidOrder();
  const purchase = buildPurchaseEvent(order, order.tracking!, now);
  assert.equal(purchase.event_name, "Purchase");
  assert.equal(purchase.event_id, order.txnid);
  assert.equal(purchase.event_time, 1792576800);
  assert.equal(purchase.action_source, "website");
  assert.equal(purchase.event_source_url, "https://growthaudit.growsparkconsulting.com/");
  assert.deepEqual(purchase.custom_data, {
    currency: "INR",
    value: 999,
    content_name: "Business Growth Audit",
    content_category: "paid",
    order_id: order.txnid,
  });

  const lead = buildFreeLeadEvent({ submissionId: "FREE_1", customer: makeCustomer() }, { consent: "granted" }, now);
  assert.equal(lead.event_id, "FREE_1");
  assert.equal(lead.event_source_url, "https://growthaudit-free.growsparkconsulting.com/");
  assert.deepEqual(lead.custom_data, { content_name: "Business Growth Audit", content_category: "free" });

  const serialized = JSON.stringify([purchase, lead]);
  for (const raw of ["asha@vermatextiles.example", "98765", "Asha", "Verma"]) {
    assert.equal(serialized.includes(raw), false, `raw value leaked: ${raw}`);
  }
});

// ---- Server: Conversions API requests ----------------------------------------------------

test("events are posted with the token in the body (never the URL) and the Test Events code when set", async () => {
  let url = "";
  let body: Record<string, unknown> = {};
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    url = String(input);
    body = JSON.parse(String(init?.body));
    return Response.json({ events_received: 1, fbtrace_id: "trace" });
  }) as typeof fetch;

  const event = buildFreeLeadEvent({ submissionId: "FREE_1", customer: makeCustomer() }, { consent: "granted" }, new Date());
  const result = await sendMetaEvents([event], { ...CONFIG, testEventCode: "TEST12345" }, fetchImpl);

  assert.deepEqual(result, { ok: true });
  assert.equal(url, `https://graph.facebook.com/v24.0/${PIXEL_ID}/events`);
  assert.equal(url.includes(TOKEN), false);
  assert.equal(body.access_token, TOKEN);
  assert.equal(body.test_event_code, "TEST12345");
  assert.deepEqual(body.data, [event]);
});

test("Meta errors and timeouts are reported by code only, never with the token", async () => {
  const rejected = await sendMetaEvents(
    [],
    CONFIG,
    (async () => Response.json({ error: { code: 190, message: "Invalid OAuth access token" } }, { status: 400 })) as typeof fetch
  );
  assert.deepEqual(rejected, { ok: false, error: "META_HTTP_400_190" });

  const timedOut = await sendMetaEvents([], CONFIG, (async () => {
    throw new DOMException("timed out", "TimeoutError");
  }) as typeof fetch);
  assert.deepEqual(timedOut, { ok: false, error: "META_TIMEOUT" });
  assert.equal(JSON.stringify([rejected, timedOut]).includes(TOKEN), false);
});

test("the Conversions API is off unless a Pixel ID and access token are configured", () => {
  const env = process.env as Record<string, string | undefined>;
  const keys = ["NEXT_PUBLIC_META_PIXEL_ID", "META_CAPI_ACCESS_TOKEN", "META_TEST_EVENT_CODE", "META_GRAPH_API_VERSION"];
  const previous = new Map(keys.map((key) => [key, env[key]]));
  try {
    for (const key of keys) delete env[key];
    assert.equal(getMetaCapiConfig(), null);
    env.NEXT_PUBLIC_META_PIXEL_ID = PIXEL_ID;
    assert.equal(getMetaCapiConfig(), null, "no token");
    env.META_CAPI_ACCESS_TOKEN = TOKEN;
    env.META_TEST_EVENT_CODE = "TEST12345";
    assert.deepEqual(getMetaCapiConfig(), { ...CONFIG, testEventCode: "TEST12345" });
    env.NEXT_PUBLIC_META_PIXEL_ID = "not-a-pixel";
    assert.equal(getMetaCapiConfig(), null);
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
  }
});

// ---- Server: when events are sent --------------------------------------------------------

test("Purchase is sent only for a verified PAID order whose checkout had consent", async () => {
  const { deps, sentEvents } = memoryDelivery();
  assert.equal(await sendPurchaseConversion(null, deps), "not_paid");
  assert.equal(await sendPurchaseConversion(paidOrder({ status: "PENDING" }), deps), "not_paid");
  assert.equal(await sendPurchaseConversion(paidOrder({ status: "FAILED" }), deps), "not_paid");
  assert.equal(await sendPurchaseConversion(paidOrder({ tracking: undefined }), deps), "no_consent");
  assert.equal(sentEvents.length, 0);

  assert.equal(await sendPurchaseConversion(paidOrder(), deps), "sent");
  assert.equal(sentEvents[0].event_id, "GSA_1792400000000_abcd1234");
});

test("repeated PayU callbacks send the server Purchase exactly once", async () => {
  const { deps, sentEvents } = memoryDelivery();
  const outcomes = await Promise.all([
    sendPurchaseConversion(paidOrder(), deps),
    sendPurchaseConversion(paidOrder(), deps),
  ]);
  outcomes.push(await sendPurchaseConversion(paidOrder(), deps));
  assert.deepEqual(outcomes.sort(), ["already_sent", "already_sent", "sent"]);
  assert.equal(sentEvents.length, 1);
});

test("a failed send releases the claim so the next trigger can deliver it", async () => {
  const warn = mock.method(console, "warn", () => undefined);
  try {
    const { deps, sentEvents } = memoryDelivery([{ ok: false }]);
    assert.equal(await sendPurchaseConversion(paidOrder(), deps), "failed");
    assert.equal(await sendPurchaseConversion(paidOrder(), deps), "sent");
    assert.equal(sentEvents.length, 1);
  } finally {
    warn.mock.restore();
  }
});

test("server Lead requires consent and is sent once per saved submission", async () => {
  const { deps, sentEvents } = memoryDelivery();
  const submission = { submissionId: "FREE_1792400000000_ab12cd34", customer: makeCustomer() };
  assert.equal(await sendFreeLeadConversion(submission, null, deps), "no_consent");
  assert.equal(await sendFreeLeadConversion(submission, { consent: "granted" }, deps), "sent");
  assert.equal(await sendFreeLeadConversion(submission, { consent: "granted" }, deps), "already_sent");
  assert.equal(sentEvents.length, 1);
  assert.equal(sentEvents[0].event_name, "Lead");
  assert.equal(sentEvents[0].event_id, submission.submissionId);
});

test("without Conversions API credentials nothing is claimed or sent", async () => {
  const { deps, sentEvents } = memoryDelivery();
  const warn = mock.method(console, "warn", () => undefined);
  try {
    assert.equal(await sendPurchaseConversion(paidOrder(), { ...deps, config: () => null }), "not_configured");
    assert.equal(await sendPurchaseConversion(paidOrder(), deps), "sent", "a later configured attempt still sends");
    assert.equal(sentEvents.length, 1);
  } finally {
    warn.mock.restore();
  }
});

// ---- MongoDB persistence -------------------------------------------------------------------

async function withFakeMongo(
  collections: Record<string, Record<string, (...args: unknown[]) => unknown>>,
  run: (calls: { collection: string; method: string; args: unknown[] }[]) => Promise<void>
) {
  const env = process.env as Record<string, string | undefined>;
  const previous = { NODE_ENV: env.NODE_ENV, MONGODB_URI: env.MONGODB_URI };
  const previousGlobalPromise = global._mongoClientPromise;
  env.NODE_ENV = "development";
  env.MONGODB_URI = "mongodb://127.0.0.1:27017/test";
  global._mongoClientPromise = undefined;
  const calls: { collection: string; method: string; args: unknown[] }[] = [];
  const connectMock = mock.method(MongoClient.prototype, "connect", async function (this: MongoClient) {
    return this;
  });
  const dbMock = mock.method(MongoClient.prototype, "db", () => ({
    collection: (name: string) =>
      new Proxy(
        {},
        {
          // Not a thenable: an async function returning this collection must not await it.
          get: (_target, method: string) =>
            method === "then"
              ? undefined
              : (...args: unknown[]) => {
                  calls.push({ collection: name, method, args });
                  return collections[name]?.[method]?.(...args) ?? Promise.resolve(null);
                },
        }
      ),
  }) as unknown as Db);
  try {
    await run(calls);
  } finally {
    connectMock.mock.restore();
    dbMock.mock.restore();
    global._mongoClientPromise = previousGlobalPromise;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
  }
}

test("each server event is claimed atomically on its own record before sending", async () => {
  const now = new Date("2026-10-21T10:00:00.000Z");
  await withFakeMongo(
    { orders: { findOneAndUpdate: async () => ({ txnid: "GSA_1" }) }, free_submissions: { findOneAndUpdate: async () => null } },
    async (calls) => {
      const store = createMongoMetaDeliveryStore();
      assert.equal(await store.claim("purchase", "GSA_1", now), true);
      assert.equal(await store.claim("lead", "FREE_1", now), false);
      assert.deepEqual(calls[0], {
        collection: "orders",
        method: "findOneAndUpdate",
        args: [
          {
            txnid: "GSA_1",
            "meta.purchaseSentAt": null,
            $or: [
              { "meta.purchaseClaimedAt": null },
              { "meta.purchaseClaimedAt": { $lt: new Date(now.getTime() - 120_000) } },
            ],
          },
          { $set: { "meta.purchaseClaimedAt": now } },
        ],
      });
      assert.equal(calls[1].collection, "free_submissions");
      assert.deepEqual((calls[1].args[0] as Record<string, unknown>).submissionId, "FREE_1");
    }
  );
});

test("an order stores tracking data only when the visitor consented at checkout", async () => {
  const inserted: OrderDocument[] = [];
  await withFakeMongo(
    {
      orders: {
        createIndex: async () => "ok",
        insertOne: async (doc: unknown) => {
          inserted.push(doc as OrderDocument);
          return { insertedId: "id" };
        },
      },
    },
    async () => {
      await createOrder(makeCustomer());
      await createOrder(makeCustomer(), { consent: "granted", fbp: "fb.1.1792400000000.123456789" });
    }
  );
  assert.equal("tracking" in inserted[0], false);
  assert.deepEqual(inserted[1].tracking, { consent: "granted", fbp: "fb.1.1792400000000.123456789" });
});
