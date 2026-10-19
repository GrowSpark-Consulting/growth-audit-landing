export function Hero({ variant = "paid" }: { variant?: "paid" | "free" }) {
  return (
    <section className="hero">
      <div className="wrap hero-grid">
        <div>
          <h1>
            9 out of 10 owners are <em>stuck</em> in their own business.
          </h1>
          <p className="hero-copy">
            Be the one who isn’t. When revenue stalls, we find what is holding growth back and work alongside your
            team like an in-house growth partner to make the next moves clear.
          </p>
          {variant === "paid" && (
          <div
            className="price-offer"
            aria-label="Business Growth Audit: regular price ₹10,000, offer price ₹999"
          >
            <div className="price-title">Business Growth Audit</div>
            <div className="price-comparison">
              <div className="price-old">
                <small>Regular price</small>
                <strong className="price-regular">
                  <s>₹10,000</s>
                </strong>
              </div>
              <span className="price-arrow" aria-hidden="true">
                →
              </span>
              <div className="price-current">
                <small>Offer price</small>
                <strong>₹999</strong>
              </div>
            </div>
          </div>
          )}
          <div className="hero-actions">
            <a className="btn" href="#name">
              Find what’s holding you back <span className="arrow">↗</span>
            </a>
            <span className="microcopy">A focused review of how your business really works.</span>
          </div>
        </div>
      </div>
    </section>
  );
}
