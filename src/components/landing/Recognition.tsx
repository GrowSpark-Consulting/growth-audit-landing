const SYMPTOMS = [
  "Every important decision still waits for you.",
  "Sales are inconsistent, or growth feels harder than it should.",
  "Your team is busy, but ownership and handoffs are unclear.",
  "Processes live in people’s heads, so the same issues keep returning.",
  "You can see opportunity, but don’t know which constraint to solve first.",
];

export function Recognition() {
  return (
    <section className="section" id="recognition">
      <div className="wrap recognition">
        <div className="section-head">
          <h2>Your business is growing. So is the weight on your shoulders.</h2>
          <p>When revenue stalls, we find the constraint and what to tackle first.</p>
        </div>
        <div>
          <div className="symptom-list">
            {SYMPTOMS.map((text, i) => (
              <div className="symptom" key={text}>
                <span className="num">{String(i + 1).padStart(2, "0")}</span>
                <p>{text}</p>
              </div>
            ))}
          </div>
          <div className="callout">
            <strong>The issue may not be effort.</strong> It may be the way the parts of your business connect, and
            where they rely too heavily on you.
          </div>
        </div>
      </div>
    </section>
  );
}
