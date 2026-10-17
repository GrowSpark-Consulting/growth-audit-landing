"use client";

import Link from "next/link";
import { useRef, useState, type FormEvent } from "react";

const TEAM_SIZES = ["1-5", "6-15", "16-30", "31-75", "76+"];
const INDUSTRIES = [
  "Professional services",
  "Technology & software",
  "Manufacturing",
  "Retail & e-commerce",
  "Healthcare & wellness",
  "Financial services",
  "Education & training",
  "Construction & real estate",
  "Hospitality & food",
  "Other",
];
const REVENUES = [
  "Below ₹50 lakh",
  "₹50 lakh-₹1 crore",
  "₹1-2 crore",
  "₹2-3 crore",
  "₹3-5 crore",
  "Above ₹5 crore",
  "Prefer to discuss",
];
const CHALLENGES = [
  "Revenue is growing, but profit is not",
  "Stuck at the same revenue for years",
  "My revenue is going down every year",
  "Another business challenge",
];

/**
 * The original page had no backend: a valid submit only revealed a "preview" notice.
 * That behaviour is preserved on purpose — no lead is stored and no payment is taken
 * until a real endpoint / gateway is connected (see README).
 */
export function LeadForm() {
  const [submitted, setSubmitted] = useState(false);
  const messageRef = useRef<HTMLDivElement>(null);

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!e.currentTarget.reportValidity()) return;
    setSubmitted(true);
    requestAnimationFrame(() =>
      messageRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }),
    );
  }

  return (
    <form className="form-card" id="leadForm" onSubmit={onSubmit}>
      <h3>Request a Growth Audit conversation</h3>
      <p>Complete the details below and our team can follow up with context.</p>
      <p className="form-price">
        Current audit offer: <strong>₹999</strong> <span>Regular price <s>₹10,000</s></span>
      </p>
      <div className="fields">
        <div className="field">
          <label htmlFor="name">Your name *</label>
          <input id="name" name="name" autoComplete="name" placeholder="Full name" required />
        </div>
        <div className="field">
          <label htmlFor="phone">Phone number *</label>
          <input
            id="phone"
            name="phone"
            type="tel"
            autoComplete="tel"
            defaultValue="+91 "
            placeholder="+91 98765 43210"
            required
          />
        </div>
        <div className="field">
          <label htmlFor="email">Work email *</label>
          <input id="email" name="email" type="email" autoComplete="email" placeholder="you@company.com" required />
        </div>
        <div className="field">
          <label htmlFor="company">Company name *</label>
          <input id="company" name="company" autoComplete="organization" placeholder="Company name" required />
        </div>
        <div className="field">
          <label htmlFor="website">Company website</label>
          <input id="website" name="website" type="url" placeholder="https://" />
        </div>
        <div className="field">
          <label htmlFor="team">Team size *</label>
          <select id="team" name="team" required defaultValue="">
            <option value="" disabled>
              Select team size
            </option>
            {TEAM_SIZES.map((o) => (
              <option key={o}>{o}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="industry">Industry *</label>
          <select id="industry" name="industry" required defaultValue="">
            <option value="" disabled>
              Select your industry
            </option>
            {INDUSTRIES.map((o) => (
              <option key={o}>{o}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="revenue">Annual revenue *</label>
          <select id="revenue" name="revenue" required defaultValue="">
            <option value="" disabled>
              Select a range
            </option>
            {REVENUES.map((o) => (
              <option key={o}>{o}</option>
            ))}
          </select>
        </div>
        <div className="field full">
          <label htmlFor="businessProblem">What is the main challenge in your business right now? *</label>
          <select id="businessProblem" name="businessProblem" required defaultValue="">
            <option value="" disabled>
              Select the closest match
            </option>
            {CHALLENGES.map((o) => (
              <option key={o}>{o}</option>
            ))}
          </select>
        </div>
      </div>
      <button className="btn" type="submit">
        Continue to payment · ₹999 <span className="arrow">↗</span>
      </button>
      <p className="privacy">Your details will only be used to respond to your inquiry.</p>
      <div
        className="form-message"
        id="formMessage"
        role="status"
        ref={messageRef}
        style={submitted ? { display: "block" } : undefined}
      >
        This preview does not process payments yet. After connecting your form and payment gateway, send successful
        payments to /thank-you. <Link href="/thank-you">Preview the thank-you page</Link>.
      </div>
    </form>
  );
}
