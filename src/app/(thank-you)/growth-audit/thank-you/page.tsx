import Link from "next/link";

export default function GrowthAuditThankYouPage() {
  return (
    <>
      <header className="top">
        <div className="wrap">
          <nav className="nav">
            <Link className="brand" href="/">
              <span className="mark" aria-hidden="true">
                ✳
              </span>
              <span>Grow Spark Consulting</span>
            </Link>
          </nav>
        </div>
      </header>

      <main>
        <div className="wrap">
          <article className="success-card">
            <section className="success-top">
              <div className="check" aria-hidden="true">
                ✓
              </div>
              <div className="eyebrow">REQUEST RECEIVED</div>
              <h1>Thank you for contacting Grow Spark Consulting!</h1>
              <p>
                Your Growth Audit request has been received successfully. Our team will review your details and contact
                you to discuss the next steps for your business.
              </p>
            </section>
            <section className="inner">
              <h2>What happens next</h2>
              <div className="steps">
                <div className="step">
                  <span className="step-num">1</span>
                  <div>
                    <h3>Save Grow Spark to your contacts</h3>
                    <p>Download our contact details so you can easily recognize our calls and messages.</p>
                  </div>
                </div>
                <div className="step">
                  <span className="step-num">2</span>
                  <div>
                    <h3>Our team will contact you</h3>
                    <p>
                      We&apos;ll review your Growth Audit enquiry and get in touch to understand your business goals and
                      challenges.
                    </p>
                  </div>
                </div>
                <div className="step">
                  <span className="step-num">3</span>
                  <div>
                    <h3>Discuss your growth opportunities</h3>
                    <p>We&apos;ll explain the next steps based on the information you submitted.</p>
                  </div>
                </div>
              </div>
              <section className="contact-box">
                <h2>Save our contact</h2>
                <p>Add Grow Spark Consulting to your address book for easy follow-up.</p>
                <a className="save-button" href="/growspark-contact.vcf" download="growspark-contact.vcf">
                  ＋ Save Grow Spark Contact
                </a>
              </section>
              <section className="framework-box">
                <h2>Your Grow Spark framework</h2>
                <p>
                  The Grow Spark Business Transformation Framework will be shared here as part of your audit materials.
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
