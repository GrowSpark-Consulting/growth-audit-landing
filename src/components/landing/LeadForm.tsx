"use client";

import { useRef, useState, type FormEvent } from "react";
import { submitFreeRequest } from "@/lib/free-submit-client";

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

export function LeadForm({ variant = "paid" }: { variant?: "paid" | "free" }) {
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const messageRef = useRef<HTMLDivElement>(null);

  const [submitted, setSubmitted] = useState(false);

  function readPayload(form: HTMLFormElement) {
    const formData = new FormData(form);
    return {
      name: formData.get("name"),
      phone: formData.get("phone"),
      email: formData.get("email"),
      company: formData.get("company"),
      website: formData.get("website") || undefined,
      team: formData.get("team"),
      industry: formData.get("industry"),
      revenue: formData.get("revenue"),
      businessProblem: formData.get("businessProblem"),
    };
  }

  /** Free workflow: saved to the CRM server-side; there is no checkout step. */
  async function submitFree(form: HTMLFormElement) {
    setSubmitting(true);
    setErrorMessage(null);
    setStatusMessage("Submitting your request...");
    // Success is shown only when the server reports the Lead was saved to the CRM.
    const outcome = await submitFreeRequest(readPayload(form));
    if (outcome.ok) {
      setStatusMessage(
        "Thank you. Your request has been received, and our team will be in touch shortly with next steps."
      );
      setSubmitted(true);
    } else {
      setErrorMessage(outcome.message);
      setStatusMessage(null);
    }
    setSubmitting(false);
    requestAnimationFrame(() =>
      messageRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" })
    );
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    if (!form.reportValidity()) return;
    if (variant === "free") {
      if (!submitted) await submitFree(form);
      return;
    }

    setSubmitting(true);
    setErrorMessage(null);
    setStatusMessage("Preparing your secure checkout session...");

    try {
      const formData = new FormData(form);
      const payload = {
        name: formData.get("name"),
        phone: formData.get("phone"),
        email: formData.get("email"),
        company: formData.get("company"),
        website: formData.get("website") || undefined,
        team: formData.get("team"),
        industry: formData.get("industry"),
        revenue: formData.get("revenue"),
        businessProblem: formData.get("businessProblem"),
      };

      const response = await fetch("/api/payment/initiate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = await response.json();

      if (!response.ok || !data.ok) {
        const errorText =
          data.error ||
          (Array.isArray(data.errors)
            ? data.errors.join(" ")
            : "Unable to start checkout. Please review your details and try again.");
        setErrorMessage(errorText);
        setStatusMessage(null);
        setSubmitting(false);
        requestAnimationFrame(() =>
          messageRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" })
        );
        return;
      }

      setStatusMessage("Connecting to PayU India Hosted Checkout...");

      // Submit an auto-submitting POST form to PayU's payment gateway URL
      const payuForm = document.createElement("form");
      payuForm.method = "POST";
      payuForm.action = data.action;
      payuForm.style.display = "none";

      if (data.params && typeof data.params === "object") {
        Object.entries(data.params).forEach(([key, value]) => {
          if (value !== undefined && value !== null) {
            const input = document.createElement("input");
            input.type = "hidden";
            input.name = key;
            input.value = String(value);
            payuForm.appendChild(input);
          }
        });
      }

      document.body.appendChild(payuForm);
      payuForm.submit();
    } catch (err) {
      console.error("[LEAD_FORM] Submission error:", err);
      setErrorMessage("Network error connecting to payment gateway. Please check your connection and try again.");
      setStatusMessage(null);
      setSubmitting(false);
      requestAnimationFrame(() =>
        messageRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" })
      );
    }
  }

  return (
    <form className="form-card" id="leadForm" onSubmit={onSubmit}>
      <h3>Request a Growth Audit conversation</h3>
      <p>Complete the details below and our team can follow up with context.</p>
      {variant === "paid" && (
        <p className="form-price">
          Current audit offer: <strong>₹999</strong> <span>Regular price <s>₹10,000</s></span>
        </p>
      )}
      <div className="fields">
        <div className="field">
          <label htmlFor="name">Your name *</label>
          <input
            id="name"
            name="name"
            autoComplete="name"
            placeholder="Full name"
            required
            disabled={submitting}
          />
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
            disabled={submitting}
          />
        </div>
        <div className="field">
          <label htmlFor="email">Work email *</label>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            placeholder="you@company.com"
            required
            disabled={submitting}
          />
        </div>
        <div className="field">
          <label htmlFor="company">Company name *</label>
          <input
            id="company"
            name="company"
            autoComplete="organization"
            placeholder="Company name"
            required
            disabled={submitting}
          />
        </div>
        <div className="field">
          <label htmlFor="website">Company website</label>
          <input
            id="website"
            name="website"
            type="text"
            inputMode="url"
            autoComplete="url"
            maxLength={255}
            pattern={String.raw`\s*(https?:\/\/)?([A-Za-z0-9\-]+\.)+[A-Za-z]{2,}(:\d+)?([\/?#]\S*)?\s*`}
            title="Enter a website like www.yourcompany.com"
            placeholder="www.yourcompany.com"
            disabled={submitting}
          />
        </div>
        <div className="field">
          <label htmlFor="team">Team size *</label>
          <select id="team" name="team" required defaultValue="" disabled={submitting}>
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
          <select id="industry" name="industry" required defaultValue="" disabled={submitting}>
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
          <select id="revenue" name="revenue" required defaultValue="" disabled={submitting}>
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
          <select
            id="businessProblem"
            name="businessProblem"
            required
            defaultValue=""
            disabled={submitting}
          >
            <option value="" disabled>
              Select the closest match
            </option>
            {CHALLENGES.map((o) => (
              <option key={o}>{o}</option>
            ))}
          </select>
        </div>
      </div>
      <button className="btn" type="submit" disabled={submitting || submitted}>
        {variant === "free" ? (
          <>
            {submitting ? "Submitting..." : "Request Your Free Growth Audit"}{" "}
            <span className="arrow">↗</span>
          </>
        ) : submitting ? (
          <>Connecting to PayU Checkout...</>
        ) : (
          <>
            Continue to payment · ₹999 <span className="arrow">↗</span>
          </>
        )}
      </button>
      <p className="privacy">Your details will only be used to respond to your inquiry.</p>

      {errorMessage && (
        <div
          className="form-message"
          role="alert"
          ref={messageRef}
          style={{
            display: "block",
            background: "#fde8e8",
            color: "#9b1c1c",
            border: "1px solid #f8b4b4",
          }}
        >
          {errorMessage}
        </div>
      )}

      {statusMessage && !errorMessage && (
        <div
          className="form-message"
          role="status"
          ref={messageRef}
          style={{ display: "block" }}
        >
          {statusMessage}
        </div>
      )}
    </form>
  );
}
