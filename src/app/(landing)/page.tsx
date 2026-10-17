import { AuditAreas } from "@/components/landing/AuditAreas";
import { ClientStories } from "@/components/landing/ClientStories";
import { Closing } from "@/components/landing/Closing";
import { CountdownTimer } from "@/components/landing/CountdownTimer";
import { Deliverables } from "@/components/landing/Deliverables";
import { Faq } from "@/components/landing/Faq";
import { Footer } from "@/components/landing/Footer";
import { Framework } from "@/components/landing/Framework";
import { Hero } from "@/components/landing/Hero";
import { LeadForm } from "@/components/landing/LeadForm";
import { PageEffects } from "@/components/landing/PageEffects";
import { Recognition } from "@/components/landing/Recognition";
import { StickyCta } from "@/components/landing/StickyCta";

// Testimonial placeholders are hidden until approved case studies exist.
// Set to true to show the section again; the component is untouched.
const SHOW_CLIENT_STORIES = false;

export default function Home() {
  return (
    <>
      <CountdownTimer />
      <main id="top">
        <Hero />
        <Recognition />
        <AuditAreas />
        <Deliverables />
        <Framework />
        <section className="section form-section" id="audit-form">
          <div className="wrap form-layout">
            <div className="form-copy">
              <h2>Let’s find the constraint behind the slowdown.</h2>
              <p>Share what is happening in your business. We’ll follow up to discuss fit and next steps.</p>
              <ul className="checklist">
                <li>Share your current growth challenge</li>
                <li>Tell us where the owner is still the linchpin</li>
                <li>Help us understand your goals and readiness</li>
              </ul>
              <p className="microcopy" style={{ color: "#707d73" }}>
                No pressure to commit. The first step is understanding whether the audit fits.
              </p>
            </div>
            <LeadForm />
          </div>
        </section>
        {SHOW_CLIENT_STORIES && <ClientStories />}
        <Faq />
        <Closing />
      </main>
      <StickyCta />
      <Footer />
      <PageEffects />
    </>
  );
}
