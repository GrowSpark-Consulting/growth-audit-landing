import { CookiePreferencesButton } from "@/components/tracking/MetaTracking";
import { BrandLogo } from "./Logo";

export function Footer() {
  return (
    <footer>
      <div className="wrap foot">
        <a className="brand" href="#top">
          <BrandLogo />
          <span>Grow Spark Consulting</span>
        </a>
        <span>
          © 2026 Grow Spark Consulting <CookiePreferencesButton />
        </span>
        <span className="foot-note">
          A diagnostic and advisory service. Recommendations are tailored to the information available; business
          outcomes depend on implementation and external conditions.
        </span>
      </div>
    </footer>
  );
}
