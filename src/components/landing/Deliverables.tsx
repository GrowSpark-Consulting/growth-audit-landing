const ITEMS = [
  {
    title: "Your business map",
    text: "A practical view of how the key parts of your business connect, from first contact through delivery and retention.",
  },
  { title: "The growth constraint", text: "The main constraint, where it appears, and why it matters." },
  {
    title: "A tailored action plan",
    text: "Recommended fixes across areas such as marketing, sales, technology, people, and operations, with a sensible order of operations.",
  },
  {
    title: "Less owner dependency",
    text: "Clear decision rights and recurring responsibilities shared across the team.",
  },
  { title: "Clearer ways of working", text: "Priority SOPs, handoffs, and accountability for consistent delivery." },
  { title: "Next-step priorities", text: "A clear first move for your team, with lower priorities set aside." },
];

export function Deliverables() {
  return (
    <section className="section deliver">
      <div className="wrap">
        <div className="section-head">
          <h2>Leave with a map, not another pile of ideas.</h2>
          <p>
            Get a clear view of what is keeping revenue stuck, what can unlock growth, and where to focus first. We
            work alongside your team as an in-house partner.
          </p>
        </div>
        <div className="deliver-grid">
          {ITEMS.map((item, i) => (
            <article className="deliver-card" key={item.title}>
              <span className="num">{String(i + 1).padStart(2, "0")}</span>
              <h3>{item.title}</h3>
              <p>{item.text}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
