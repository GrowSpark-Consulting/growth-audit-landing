const FAQS = [
  {
    q: "What happens during a Business Growth Audit?",
    a: "We map key workflows, find the constraint limiting growth, and provide a documented diagnosis with tailored recommendations.",
  },
  {
    q: "Is this only for marketing or sales?",
    a: "No. We look across strategy, marketing, sales, operations, technology, people, delivery, and retention.",
  },
  {
    q: "Will the audit guarantee 2-10× growth?",
    a: "No growth result is guaranteed. The audit identifies constraints and gives you a practical plan; outcomes depend on execution and market conditions.",
  },
  {
    q: "Will you give us a ready-made SOP library?",
    a: "The audit identifies priority SOPs and ownership gaps. Creating them can be scoped to your workflows and implementation needs.",
  },
  {
    q: "How much time will we need to contribute?",
    a: "It depends on your business. We’ll outline the time and information needed before the audit begins.",
  },
  {
    q: "What happens after I submit the form?",
    a: "We’ll review your details and follow up to discuss your goals, constraints, and fit. Submitting the form does not commit you to an engagement.",
  },
];

export function Faq() {
  return (
    <section className="faq">
      <div className="wrap faq-grid">
        <div className="section-head">
          <h2>Before you take the next step.</h2>
          <p></p>
        </div>
        <div className="faq-list">
          {FAQS.map((f) => (
            <details key={f.q}>
              <summary>{f.q}</summary>
              <p>{f.a}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}
