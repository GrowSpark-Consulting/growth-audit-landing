import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Hero } from "../src/components/landing/Hero";
import { LeadForm } from "../src/components/landing/LeadForm";
import { StickyCta } from "../src/components/landing/StickyCta";

const render = (element: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(element);

test("paid variant (the default) still shows the price and payment button", () => {
  const hero = render(createElement(Hero));
  const form = render(createElement(LeadForm));
  const sticky = render(createElement(StickyCta));

  assert.match(hero, /price-offer/);
  assert.match(hero, /₹999/);
  assert.match(form, /form-price/);
  assert.match(form, /Continue to payment · ₹999/);
  assert.match(sticky, /cta-price/);
  assert.equal(render(createElement(Hero, { variant: "paid" })), hero);
  assert.equal(render(createElement(LeadForm, { variant: "paid" })), form);
});

test("free variant removes every price block and uses the approved CTA", () => {
  const hero = render(createElement(Hero, { variant: "free" }));
  const form = render(createElement(LeadForm, { variant: "free" }));
  const sticky = render(createElement(StickyCta, { variant: "free" }));

  // Revenue-range <option>s legitimately contain ₹; everything else must be price-free.
  for (const html of [hero, form, sticky]) {
    assert.doesNotMatch(html.replace(/<option[^>]*>.*?<\/option>/g, ""), /₹|price|payment|PayU|checkout/i);
  }
  assert.match(form, /Request Your Free Growth Audit/);
});

test("free and paid forms keep identical fields", () => {
  const names = (html: string) => [...html.matchAll(/name="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(names(render(createElement(LeadForm, { variant: "free" }))), names(render(createElement(LeadForm))));
});
