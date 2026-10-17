"use client";

import { useEffect } from "react";

/**
 * Behaviour carried over from the original page's inline scripts:
 *  - "#name" links smooth-scroll to the name field and focus it
 *  - sections fade in once as they enter the viewport
 */
export function PageEffects() {
  useEffect(() => {
    const cleanups: Array<() => void> = [];

    document.querySelectorAll<HTMLAnchorElement>('a[href="#name"]').forEach((link) => {
      const onClick = (e: MouseEvent) => {
        e.preventDefault();
        const field = document.getElementById("name");
        if (!field) return;
        field.scrollIntoView({ behavior: "smooth", block: "center" });
        window.setTimeout(() => field.focus({ preventScroll: true }), 350);
      };
      link.addEventListener("click", onClick);
      cleanups.push(() => link.removeEventListener("click", onClick));
    });

    const items = document.querySelectorAll<HTMLElement>(".section,.framework,.proof,.faq,.closing");
    items.forEach((el) => el.classList.add("reveal"));
    if (!("IntersectionObserver" in window) || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      items.forEach((el) => el.classList.add("is-visible"));
    } else {
      const observer = new IntersectionObserver(
        (entries) =>
          entries.forEach((entry) => {
            if (entry.isIntersecting) {
              entry.target.classList.add("is-visible");
              observer.unobserve(entry.target);
            }
          }),
        { threshold: 0.08 },
      );
      items.forEach((el) => observer.observe(el));
      cleanups.push(() => observer.disconnect());
    }

    return () => cleanups.forEach((fn) => fn());
  }, []);

  return null;
}
