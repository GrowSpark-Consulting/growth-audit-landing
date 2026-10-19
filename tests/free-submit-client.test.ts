import assert from "node:assert/strict";
import test from "node:test";
import { submitFreeRequest } from "../src/lib/free-submit-client";

const reply = (status: number, body: unknown) => (async () => Response.json(body, { status })) as typeof fetch;

test("success is reported only for an ok response that the server marked ok", async () => {
  assert.deepEqual(await submitFreeRequest({}, reply(200, { ok: true })), { ok: true });
});

test("CRM failure, validation errors and odd responses never read as success", async () => {
  const crm = await submitFreeRequest({}, reply(502, { ok: false, error: "We could not save your request." }));
  assert.deepEqual(crm, { ok: false, message: "We could not save your request." });

  const invalid = await submitFreeRequest({}, reply(400, { ok: false, errors: ["Name is required.", "Email is required."] }));
  assert.deepEqual(invalid, { ok: false, message: "Name is required. Email is required." });

  // HTTP 200 without ok:true must not count as saved.
  assert.equal((await submitFreeRequest({}, reply(200, {}))).ok, false);
  assert.equal((await submitFreeRequest({}, reply(200, { ok: "yes" }))).ok, false);
  assert.equal((await submitFreeRequest({}, (async () => new Response("<html>", { status: 502 })) as typeof fetch)).ok, false);
});

test("a network failure is an error, not success", async () => {
  const outcome = await submitFreeRequest({}, (async () => {
    throw new TypeError("failed to fetch");
  }) as typeof fetch);
  assert.equal(outcome.ok, false);
});
