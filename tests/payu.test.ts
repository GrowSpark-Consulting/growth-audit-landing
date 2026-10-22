import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  generatePayURequestHash,
  calculatePayUReverseHash,
  verifyPayUResponseHash,
  generateOrderVerificationToken,
  verifyOrderVerificationToken,
  buildPayUPaymentPayload,
  getPayUConfig,
  isPayUConfigured,
} from "../src/lib/payu";
import {
  validateCustomerInput,
  generateTransactionId,
  FIXED_ORDER_AMOUNT,
} from "../src/lib/orders";

const PAYU_ENV_KEYS = [
  "PAYU_MODE",
  "PAYU_TEST_MERCHANT_KEY",
  "PAYU_TEST_MERCHANT_SALT",
  "PAYU_PRODUCTION_MERCHANT_KEY",
  "PAYU_PRODUCTION_MERCHANT_SALT",
  "PAYU_MERCHANT_KEY",
  "PAYU_MERCHANT_SALT",
  "ORDER_VERIFICATION_SECRET",
  "NEXT_PUBLIC_SITE_URL",
] as const;

function withPayUEnvironment<T>(
  values: Partial<Record<(typeof PAYU_ENV_KEYS)[number], string>>,
  callback: () => T
): T {
  const env = process.env as Record<string, string | undefined>;
  const previous = new Map(PAYU_ENV_KEYS.map((key) => [key, env[key]]));
  for (const key of PAYU_ENV_KEYS) delete env[key];
  Object.assign(env, values);
  try {
    return callback();
  } finally {
    for (const key of PAYU_ENV_KEYS) {
      const value = previous.get(key);
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
  }
}

test("generatePayURequestHash: produces correct SHA-512 hash matching PayU specification", () => {
  const params = {
    key: "merchantKey123",
    txnid: "GSA_1700000000_abcd1234",
    amount: "999.00",
    productinfo: "Business Growth Audit",
    firstname: "Raja",
    email: "raja@growsparkconsulting.com",
    salt: "merchantSaltXYZ",
  };

  // Expected pipe string: key|txnid|amount|productinfo|firstname|email|udf1|udf2|udf3|udf4|udf5||||||salt
  // When udf1-udf5 are empty, there are 5 pipes for udf1-udf5 plus 6 reserved pipes = 11 pipes between email and salt
  const manualSequence = `${params.key}|${params.txnid}|${params.amount}|${params.productinfo}|${params.firstname}|${params.email}|||||||||||${params.salt}`;
  const expectedHash = crypto.createHash("sha512").update(manualSequence, "utf8").digest("hex").toLowerCase();

  const generatedHash = generatePayURequestHash(params);
  assert.equal(generatedHash, expectedHash);
  assert.equal(generatedHash.length, 128); // 128-char hex string
});

test("calculatePayUReverseHash: matches official PayU reverse sequence without additionalCharges", () => {
  const data = {
    key: "merchantKey123",
    txnid: "GSA_1700000000_abcd1234",
    amount: "999.00",
    productinfo: "Business Growth Audit",
    firstname: "Raja",
    email: "raja@growsparkconsulting.com",
    status: "success",
  };
  const salt = "merchantSaltXYZ";

  // Reverse sequence: salt|status||||||udf5|udf4|udf3|udf2|udf1|email|firstname|productinfo|amount|txnid|key
  const manualReverseSequence = `${salt}|${data.status}|||||||||||${data.email}|${data.firstname}|${data.productinfo}|${data.amount}|${data.txnid}|${data.key}`;
  const expectedHash = crypto.createHash("sha512").update(manualReverseSequence, "utf8").digest("hex").toLowerCase();

  const computedHash = calculatePayUReverseHash(data, salt, false);
  assert.equal(computedHash, expectedHash);
});

test("calculatePayUReverseHash: handles additionalCharges prefix when present", () => {
  const data = {
    key: "merchantKey123",
    txnid: "GSA_1700000000_abcd1234",
    amount: "999.00",
    productinfo: "Business Growth Audit",
    firstname: "Raja",
    email: "raja@growsparkconsulting.com",
    status: "success",
    additionalCharges: "10.00",
  };
  const salt = "merchantSaltXYZ";

  const manualSequenceWithCharges = `${data.additionalCharges}|${salt}|${data.status}|||||||||||${data.email}|${data.firstname}|${data.productinfo}|${data.amount}|${data.txnid}|${data.key}`;
  const expectedHash = crypto.createHash("sha512").update(manualSequenceWithCharges, "utf8").digest("hex").toLowerCase();

  const computedHash = calculatePayUReverseHash(data, salt, true);
  assert.equal(computedHash, expectedHash);
});

test("verifyPayUResponseHash: validates authentic callback and rejects tampered responses", () => {
  const salt = "testSalt99";
  const validData = {
    key: "testKey99",
    txnid: "GSA_TEST_001",
    amount: "999.00",
    productinfo: "Business Growth Audit",
    firstname: "John",
    email: "john@example.com",
    status: "success",
  };

  const validHash = calculatePayUReverseHash(validData, salt, false);

  // 1. Valid hash returns true
  assert.equal(
    verifyPayUResponseHash({ ...validData, hash: validHash }, salt),
    true
  );

  // 2. Tampered amount returns false
  const tamperedAmountData = {
    ...validData,
    amount: "1.00",
    hash: validHash,
  };
  assert.equal(verifyPayUResponseHash(tamperedAmountData, salt), false);

  // 3. Tampered status returns false
  const tamperedStatusData = {
    ...validData,
    status: "failure",
    hash: validHash,
  };
  assert.equal(verifyPayUResponseHash(tamperedStatusData, salt), false);

  // 4. Missing or corrupted hash returns false
  assert.equal(verifyPayUResponseHash({ ...validData, hash: "" }, salt), false);
  assert.equal(verifyPayUResponseHash({ ...validData, hash: "invalid_hash" }, salt), false);

  // 5. Valid hash with additionalCharges returns true
  const dataWithCharges = {
    ...validData,
    additionalCharges: "15.00",
  };
  const hashWithCharges = calculatePayUReverseHash(dataWithCharges, salt, true);
  assert.equal(
    verifyPayUResponseHash({ ...dataWithCharges, hash: hashWithCharges }, salt),
    true
  );
});

test("HMAC Order Verification Token: generates and verifies tamper-proof tokens", () => {
  const env = process.env as Record<string, string | undefined>;
  const previousSecret = env.ORDER_VERIFICATION_SECRET;
  env.ORDER_VERIFICATION_SECRET = "unit-test-verification-secret";

  try {
  const txnid = "GSA_1700000000_xyz";
  const status = "PAID";
  const amount = 999;

  const token = generateOrderVerificationToken(txnid, status, amount);
  assert.ok(token);
  assert.equal(typeof token, "string");

  // Valid verification
  assert.equal(verifyOrderVerificationToken(txnid, status, amount, token), true);

  // Tampered transaction ID
  assert.equal(
    verifyOrderVerificationToken("GSA_DIFFERENT", status, amount, token),
    false
  );

  // Tampered status
  assert.equal(
    verifyOrderVerificationToken(txnid, "PENDING", amount, token),
    false
  );

  // Tampered amount
  assert.equal(
    verifyOrderVerificationToken(txnid, status, 100, token),
    false
  );

  // Tampered token
  assert.equal(
    verifyOrderVerificationToken(txnid, status, amount, "corrupted_token"),
    false
  );
  } finally {
    if (previousSecret === undefined) delete env.ORDER_VERIFICATION_SECRET;
    else env.ORDER_VERIFICATION_SECRET = previousSecret;
  }
});

test("validateCustomerInput: enforces validation rules and normalizes fields", () => {
  const validInput = {
    name: "  Raja Sundaram  ",
    phone: "+91 98765 43210",
    email: "  RAJA@GrowSparkConsulting.com  ",
    company: "Grow Spark Consulting",
    website: "https://growsparkconsulting.com",
    city: "Chennai",
    team: "6-15",
    industry: "Professional services",
    revenue: "₹50 lakh-₹1 crore",
    businessProblem: "Revenue is growing, but profit is not",
  };

  const result = validateCustomerInput(validInput);
  assert.equal(result.valid, true);
  assert.equal(result.errors.length, 0);
  assert.ok(result.data);
  assert.equal(result.data.name, "Raja Sundaram");
  assert.equal(result.data.email, "raja@growsparkconsulting.com");
  assert.equal(result.data.phone, "+91 98765 43210");

  // Invalid email
  const badEmail = validateCustomerInput({ ...validInput, email: "invalid-email" });
  assert.equal(badEmail.valid, false);
  assert.ok(badEmail.errors.some((e) => e.includes("email")));

  // Missing name
  const badName = validateCustomerInput({ ...validInput, name: "" });
  assert.equal(badName.valid, false);
  assert.ok(badName.errors.some((e) => e.includes("name")));

  // Invalid phone (too short)
  const badPhone = validateCustomerInput({ ...validInput, phone: "123" });
  assert.equal(badPhone.valid, false);
  assert.ok(badPhone.errors.some((e) => e.includes("phone")));

  // Invalid enum selection
  const badTeam = validateCustomerInput({ ...validInput, team: "invalid-team" });
  assert.equal(badTeam.valid, false);
  assert.ok(badTeam.errors.some((e) => e.includes("team")));
});

test("generateTransactionId: creates unique, prefixed identifiers", () => {
  const id1 = generateTransactionId();
  const id2 = generateTransactionId();
  assert.ok(id1.startsWith("GSA_"));
  assert.ok(id2.startsWith("GSA_"));
  assert.notEqual(id1, id2);
  assert.equal(FIXED_ORDER_AMOUNT, 999.0);
});

test("buildPayUPaymentPayload: constructs complete payload with action URL and hash", () => {
  withPayUEnvironment({
    PAYU_MODE: "test",
    PAYU_TEST_MERCHANT_KEY: "sandbox-key",
    PAYU_TEST_MERCHANT_SALT: "sandbox-salt",
    NEXT_PUBLIC_SITE_URL: "https://sandbox.example.test/",
  }, () => {
    const payload = buildPayUPaymentPayload({
      txnid: "GSA_TEST_PAYLOAD",
      amount: 999,
      productinfo: "Business Growth Audit",
      name: "Raja Sundaram",
      email: "raja@growsparkconsulting.com",
      phone: "+91 98765 43210",
    });

    assert.equal(payload.action, "https://test.payu.in/_payment");
    assert.equal(Object.hasOwn(payload.params, "salt"), false);
    assert.equal(Object.hasOwn(payload.params, "verificationSecret"), false);
    assert.equal(JSON.stringify(payload).includes("sandbox-salt"), false);
    assert.equal(payload.params.txnid, "GSA_TEST_PAYLOAD");
    assert.equal(payload.params.amount, "999.00");
    assert.equal(payload.params.productinfo, "Business Growth Audit");
    assert.equal(payload.params.firstname, "Raja");
    assert.equal(payload.params.email, "raja@growsparkconsulting.com");
    assert.equal(payload.params.phone, "+91 98765 43210");
    assert.equal(payload.params.surl, "https://sandbox.example.test/api/payment/callback");
    assert.equal(payload.params.furl, payload.params.surl);
    assert.equal(payload.params.hash.length, 128);
  });
});

test("PayU mode selects its matching endpoint and credentials", () => {
  withPayUEnvironment({
    PAYU_MODE: "test",
    PAYU_TEST_MERCHANT_KEY: "sandbox-key",
    PAYU_TEST_MERCHANT_SALT: "sandbox-salt",
    PAYU_PRODUCTION_MERCHANT_KEY: "production-key",
    PAYU_PRODUCTION_MERCHANT_SALT: "production-salt",
    NEXT_PUBLIC_SITE_URL: "https://sandbox.example.test",
  }, () => {
    const config = getPayUConfig();
    assert.equal(config.mode, "test");
    assert.equal(config.paymentUrl, "https://test.payu.in/_payment");
    assert.equal(config.key, "sandbox-key");
    assert.equal(config.salt, "sandbox-salt");
    assert.equal(isPayUConfigured(), true);
  });

  withPayUEnvironment({
    PAYU_MODE: "production",
    PAYU_TEST_MERCHANT_KEY: "sandbox-key",
    PAYU_TEST_MERCHANT_SALT: "sandbox-salt",
    PAYU_PRODUCTION_MERCHANT_KEY: "production-key",
    PAYU_PRODUCTION_MERCHANT_SALT: "production-salt",
    NEXT_PUBLIC_SITE_URL: "https://growthaudit.growsparkconsulting.com",
  }, () => {
    const config = getPayUConfig();
    assert.equal(config.mode, "production");
    assert.equal(config.paymentUrl, "https://secure.payu.in/_payment");
    assert.equal(config.key, "production-key");
    assert.equal(config.salt, "production-salt");
    assert.equal(isPayUConfigured(), true);
  });
});

test("missing or unsupported PayU mode is rejected", () => {
  withPayUEnvironment({}, () => {
    assert.throws(() => getPayUConfig(), /PAYU_MODE must be explicitly set/);
    assert.equal(isPayUConfigured(), false);
  });

  withPayUEnvironment({ PAYU_MODE: "staging" }, () => {
    assert.throws(() => getPayUConfig(), /PAYU_MODE must be explicitly set/);
    assert.equal(isPayUConfigured(), false);
  });
});

test("production never falls back to test credentials", () => {
  withPayUEnvironment({
    PAYU_MODE: "production",
    PAYU_MERCHANT_KEY: "legacy-test-key",
    PAYU_MERCHANT_SALT: "legacy-test-salt",
    PAYU_TEST_MERCHANT_KEY: "sandbox-key",
    PAYU_TEST_MERCHANT_SALT: "sandbox-salt",
    NEXT_PUBLIC_SITE_URL: "https://growthaudit.growsparkconsulting.com",
  }, () => {
    const config = getPayUConfig();
    assert.equal(config.paymentUrl, "https://secure.payu.in/_payment");
    assert.equal(config.key, "");
    assert.equal(config.salt, "");
    assert.equal(isPayUConfigured(), false);
  });
});

test("production verification token does not fall back to test salt", () => {
  withPayUEnvironment({
    PAYU_MODE: "production",
    PAYU_MERCHANT_SALT: "legacy-test-salt",
    PAYU_TEST_MERCHANT_SALT: "sandbox-salt",
    NEXT_PUBLIC_SITE_URL: "https://growthaudit.growsparkconsulting.com",
  }, () => {
    assert.equal(generateOrderVerificationToken("GSA_TEST", "PAID", 999), "");
  });
});

test("production rejects tunnel and localhost callback origins", () => {
  for (const siteUrl of [
    "https://reassure-among-employed.ngrok-free.dev",
    "http://localhost:3000",
    "https://192.168.1.10",
    "https://ephemeral.trycloudflare.com",
  ]) {
    withPayUEnvironment({
      PAYU_MODE: "production",
      PAYU_PRODUCTION_MERCHANT_KEY: "production-key",
      PAYU_PRODUCTION_MERCHANT_SALT: "production-salt",
      NEXT_PUBLIC_SITE_URL: siteUrl,
    }, () => {
      assert.throws(() => getPayUConfig(), /public HTTPS site origin/);
      assert.equal(isPayUConfigured(), false);
    });
  }
});
