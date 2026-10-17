export default function ThankYouPage() {
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
                <strong>₹999</strong>
              </div>
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
