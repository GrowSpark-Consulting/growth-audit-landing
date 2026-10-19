import assert from "node:assert/strict";
import test from "node:test";
import { decideHostRouting, FREE_HOST, PAID_HOST } from "../src/lib/host-routing";
import { FREE_SITE_URL } from "../src/lib/site";

test("free host serves the free page at / and blocks every payment route", () => {
  assert.deepEqual(decideHostRouting(FREE_HOST, "/"), { action: "rewrite", pathname: "/free" });
  for (const path of ["/api/payment/initiate", "/api/payment/callback", "/api/orders/GSA_1/status", "/thank-you"]) {
    assert.deepEqual(decideHostRouting(FREE_HOST, path), { action: "not-found" }, path);
  }
  assert.deepEqual(decideHostRouting(FREE_HOST, "/free"), { action: "redirect", pathname: "/" });
  assert.deepEqual(decideHostRouting(`${FREE_HOST}:443`, "/api/payment/initiate"), { action: "not-found" });
  assert.deepEqual(decideHostRouting(FREE_HOST, "/api/free-submit"), { action: "next" });
});

test("paid host keeps all payment routes and never serves the free page or endpoint", () => {
  assert.deepEqual(decideHostRouting(PAID_HOST, "/"), { action: "next" });
  for (const path of ["/api/payment/initiate", "/api/payment/callback", "/api/orders/GSA_1/status", "/thank-you"]) {
    assert.deepEqual(decideHostRouting(PAID_HOST, path), { action: "next" }, path);
  }
  assert.deepEqual(decideHostRouting(PAID_HOST, "/free"), { action: "not-found" });
  assert.deepEqual(decideHostRouting(PAID_HOST, "/api/free-submit"), { action: "not-found" });
});

test("localhost and preview hosts can reach both variants for testing", () => {
  assert.deepEqual(decideHostRouting("localhost:3000", "/free"), { action: "next" });
  assert.deepEqual(decideHostRouting("preview-abc.vercel.app", "/api/payment/initiate"), { action: "next" });
  assert.deepEqual(decideHostRouting(null, "/"), { action: "next" });
});

test("free canonical origin is the free host", () => {
  assert.equal(FREE_SITE_URL, `https://${FREE_HOST}`);
});
