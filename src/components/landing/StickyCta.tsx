"use client";

import { useEffect, useState } from "react";

export function StickyCta({ variant = "paid" }: { variant?: "paid" | "free" }) {
  const [visible, setVisible] = useState(false);
  const [inForm, setInForm] = useState(false);

  useEffect(() => {
    const form = document.getElementById("audit-form");
    if (!form) return;
    const update = () => {
      const rect = form.getBoundingClientRect();
      const formVisible = rect.top < window.innerHeight && rect.bottom > 0;
      const y = window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0;
      setInForm(formVisible);
      setVisible(y > 180 && !formVisible);
    };
    window.addEventListener("scroll", update, { passive: true, capture: true });
    document.addEventListener("scroll", update, { passive: true, capture: true });
    window.addEventListener("resize", update);
    update();
    return () => {
      window.removeEventListener("scroll", update, { capture: true });
      document.removeEventListener("scroll", update, { capture: true });
      window.removeEventListener("resize", update);
    };
  }, []);

  return (
    <div className={`bottom-cta${inForm ? " is-in-form" : ""}${visible ? " is-visible" : ""}`} id="bottomCta">
      <span>Ready to find your growth constraint?</span>
      <a href="#name">
        <span>Request your audit</span>
        {variant === "paid" && (
          <span className="cta-price">
            <s>₹10,000</s>
            <b>₹999</b>
          </span>
        )}
        <span aria-hidden="true">↗</span>
      </a>
    </div>
  );
}
