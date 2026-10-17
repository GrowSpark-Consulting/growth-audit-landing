const AREAS = [
  { icon: "↗", title: "Strategy & economics", text: "Goals, offers, margins, and growth priorities." },
  { icon: "◎", title: "Marketing & demand", text: "Positioning, lead flow, channels, and conversion." },
  { icon: "⌁", title: "Sales & customer journey", text: "Pipeline, follow-up, onboarding, and customer experience." },
  { icon: "▤", title: "Operations & technology", text: "Workflows, tools, reporting, and avoidable friction." },
  { icon: "♧", title: "People & decision-making", text: "Roles, accountability, and decision-making." },
  { icon: "⟲", title: "Retention & delivery", text: "Quality, repeat business, and service consistency." },
];

export function AuditAreas() {
  return (
    <section className="section audit">
      <div className="wrap audit-layout">
        <div className="audit-intro">
          <h2>We look across the business, not just one department.</h2>
          <p>
            We work alongside your team like an in-house growth partner, finding what is holding revenue back and
            setting clear priorities.
          </p>
        </div>
        <div className="audit-list">
          {AREAS.map((a) => (
            <article className="audit-card" key={a.title}>
              <span className="icon">{a.icon}</span>
              <h3>{a.title}</h3>
              <p>{a.text}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
