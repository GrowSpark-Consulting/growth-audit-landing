import assert from "node:assert/strict";
import test from "node:test";
import { getSafeCheckoutErrorClass } from "../src/lib/checkout-diagnostics";

test("checkout diagnostics expose only allowlisted error class labels", () => {
  const mongoError = new Error("connection details must not be logged");
  mongoError.name = "MongoServerSelectionError";
  assert.equal(getSafeCheckoutErrorClass(mongoError), "MongoServerSelectionError");

  const unrecognizedError = new Error("sensitive error message");
  unrecognizedError.name = "SecretBearingCustomError";
  assert.equal(getSafeCheckoutErrorClass(unrecognizedError), "OtherError");
  assert.equal(getSafeCheckoutErrorClass("sensitive string error"), "UnknownError");
});
