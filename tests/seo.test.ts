import assert from "node:assert/strict";
import test from "node:test";
import { FREE_HOST, PAID_HOST } from "../src/lib/host-routing";
import { siteUrlForHost } from "../src/lib/seo";
import { FREE_SITE_URL, SITE_URL } from "../src/lib/site";

test("robots and sitemap point each host at its own site URL", () => {
  assert.equal(siteUrlForHost(FREE_HOST), FREE_SITE_URL);
  assert.equal(siteUrlForHost(`${FREE_HOST}:443`), FREE_SITE_URL);
  assert.equal(siteUrlForHost(PAID_HOST), SITE_URL);
  assert.equal(siteUrlForHost("localhost:3000"), SITE_URL);
  assert.equal(siteUrlForHost(null), SITE_URL);
});
