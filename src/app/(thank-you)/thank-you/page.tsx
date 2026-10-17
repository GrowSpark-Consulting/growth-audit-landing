import Link from "next/link";
import { findOrderByTxnid } from "@/lib/orders";
import { verifyOrderVerificationToken } from "@/lib/payu";

interface ThankYouPageProps {
  searchParams: Promise<{
    txnid?: string;
    token?: string;
    status?: string;
    error?: string;
  }>;
}

export default async function ThankYouPage({ searchParams }: ThankYouPageProps) {
  const { txnid, token, status, error } = await searchParams;

  let isVerified = false;
  let order = null;
  let isFailed = Boolean(error) || status === "failed";

  if (txnid && token) {
    order = await findOrderByTxnid(txnid);
    if (order) {
      const tokenMatches = verifyOrderVerificationToken(
        order.txnid,
        order.status,
        order.amount,
        token
      );
      if (tokenMatches && order.status === "PAID") {
        isVerified = true;
        isFailed = false;
      } else if (tokenMatches && order.status === "FAILED") {
        isFailed = true;
      }
    }
  }

  // 1. Verified Successful Payment State
  if (isVerified && order) {
    return (
      <>
        <main>
          <div className="wrap">
            <article className="success-card">
              <section className="success-top">
                <div className="check" aria-hidden="true">
                  ✓
                </div>
                <div className="eyebrow">Payment confirmed</div>
                <h1>Thank you. You’re on your way.</h1>
                <p>
                  Your Business Growth Audit payment is confirmed. We’ll follow up with the next steps to begin mapping
                  your business and its growth constraints.
                </p>
                <div className="price-summary">
                  <span>Business Growth Audit</span>
                  <span aria-hidden="true">·</span>
                  <s>₹10,000</s>
                  <strong>₹{order.amount.toLocaleString("en-IN")}</strong>
                </div>
                <p style={{ marginTop: "12px", fontSize: "0.78rem", color: "#68746c" }}>
                  Transaction Reference: <strong>{order.txnid}</strong>
                </p>
              </section>
              <section className="inner">
                <h2>What happens next</h2>
                <p className="intro">We’ll be in touch to get the audit moving.</p>
                <div className="steps">
                  <div className="step">
                    <span className="step-num">1</span>
                    <div>
                      <h3>Save Grow Spark to your contacts</h3>
                      <p>That way, you can recognize our follow-up and keep our details handy.</p>
                    </div>
                  </div>
                  <div className="step">
                    <span className="step-num">2</span>
                    <div>
                      <h3>We’ll contact you to get started</h3>
                      <p>We’ll confirm the information and conversations needed for your business review.</p>
                    </div>
                  </div>
                </div>
                <section className="contact-box">
                  <h2>Save our contact</h2>
                  <p>Add Grow Spark Consulting to your address book for easy follow-up.</p>
                  <a className="save-button" href="/growspark-contact.vcf" download>
                    ＋ Save Grow Spark contact
                  </a>
                </section>
                <section className="framework-box">
                  <h2>Your Grow Spark framework</h2>
                  <p>
                    The Grow Spark Business Transformation Framework will be shared here as part of your audit
                    materials.
                  </p>
                  <button className="framework-button" type="button" disabled>
                    Framework access will be added here
                  </button>
                  <p className="note">
                    This download button is ready to connect when the framework file or access link is supplied.
                  </p>
                </section>
              </section>
            </article>
          </div>
        </main>
        <footer>
          <div className="wrap foot">
            <span>© 2026 Grow Spark Consulting</span>
            <a href="https://www.growsparkconsulting.com/">growsparkconsulting.com</a>
          </div>
        </footer>
      </>
    );
  }

  // 2. Payment Failure State
  if (isFailed) {
    let failureReason = "Your transaction could not be completed or was cancelled.";
    if (error === "hash_mismatch") {
      failureReason = "Security verification failed for this transaction.";
    } else if (error === "amount_mismatch") {
      failureReason = "Transaction amount validation failed.";
    }

    return (
      <>
        <main>
          <div className="wrap">
            <article className="success-card">
              <section className="success-top">
                <div
                  className="check"
                  aria-hidden="true"
                  style={{
                    background: "#fee2e2",
                    color: "#991b1b",
                    boxShadow: "0 0 0 8px rgba(239, 68, 68, 0.15)",
                  }}
                >
                  ✕
                </div>
                <div className="eyebrow" style={{ color: "#991b1b" }}>
                  Payment Unsuccessful
                </div>
                <h1>Payment could not be completed.</h1>
                <p>{failureReason}</p>
                {txnid && (
                  <p style={{ marginTop: "12px", fontSize: "0.78rem", color: "#68746c" }}>
                    Transaction ID: <strong>{txnid}</strong>
                  </p>
                )}
                <div style={{ marginTop: "24px" }}>
                  <Link className="save-button" href="/#leadForm">
                    Return to request form
                  </Link>
                </div>
              </section>
              <section className="inner">
                <h2>What should you do?</h2>
                <p className="intro">
                  If funds were deducted from your bank or card, PayU and your bank will automatically process a refund
                  according to standard banking timelines (usually 3–5 business days).
                </p>
                <p style={{ fontSize: "0.88rem", color: "var(--muted)" }}>
                  Need assistance? Contact our team directly at{" "}
                  <a href="https://www.growsparkconsulting.com/" style={{ color: "var(--ink)", fontWeight: 700 }}>
                    Grow Spark Consulting
                  </a>
                  .
                </p>
              </section>
            </article>
          </div>
        </main>
        <footer>
          <div className="wrap foot">
            <span>© 2026 Grow Spark Consulting</span>
            <a href="https://www.growsparkconsulting.com/">growsparkconsulting.com</a>
          </div>
        </footer>
      </>
    );
  }

  // 3. Direct or Unverified Access State
  return (
    <>
      <main>
        <div className="wrap">
          <article className="success-card">
            <section className="success-top">
              <div
                className="check"
                aria-hidden="true"
                style={{
                  background: "#e2e8f0",
                  color: "#475569",
                  boxShadow: "0 0 0 8px rgba(100, 116, 139, 0.15)",
                }}
              >
                ℹ
              </div>
              <div className="eyebrow" style={{ color: "#475569" }}>
                Verification Required
              </div>
              <h1>No verified order found.</h1>
              <p>
                This confirmation page requires a verified transaction token from completed checkouts. If you have not
                requested an audit yet, you can begin on our landing page.
              </p>
              <div style={{ marginTop: "24px" }}>
                <Link className="save-button" href="/#leadForm">
                  Request a Growth Audit
                </Link>
              </div>
            </section>
            <section className="inner">
              <h2>About the Growth Audit</h2>
              <p className="intro">
                The Grow Spark Business Growth Audit pinpoints the exact operational and strategic constraints holding
                your revenue back.
              </p>
              <section className="contact-box">
                <h2>Grow Spark Consulting</h2>
                <p>Learn more about our services and methodology.</p>
                <a className="save-button" href="https://www.growsparkconsulting.com/">
                  Visit Grow Spark Consulting
                </a>
              </section>
            </section>
          </article>
        </div>
      </main>
      <footer>
        <div className="wrap foot">
          <span>© 2026 Grow Spark Consulting</span>
          <a href="https://www.growsparkconsulting.com/">growsparkconsulting.com</a>
        </div>
      </footer>
    </>
  );
}
