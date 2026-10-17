"use client";

import { useState, type KeyboardEvent } from "react";

const STORIES = [
  {
    tag: "01 / STORY SLOT",
    mark: "“",
    title: "Replace with an approved client quote",
    text: "Use a short, real statement that describes the challenge and experience. Confirm wording and permission before publishing.",
    result: "Add a verified result",
    note: "Include timeframe and context.",
  },
  {
    tag: "02 / STORY SLOT",
    mark: "↗",
    title: "Show the bottleneck that changed the plan",
    text: "Describe the business context, the constraint the audit surfaced, and the recommendation the team chose to act on.",
    result: "Insert a measured change",
    note: "Use source-backed numbers only.",
  },
  {
    tag: "03 / STORY SLOT",
    mark: "✳",
    title: "Make the owner less of a daily bottleneck",
    text: "Share a real example of clearer ownership, repeatable processes, or a better handoff, once the client has approved it.",
    result: "Add a verified result",
    note: "Explain what changed in practice.",
  },
];

export function ClientStories() {
  const [current, setCurrent] = useState(0);
  const count = STORIES.length;
  const show = (i: number) => setCurrent((i + count) % count);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowRight") show(current + 1);
    if (e.key === "ArrowLeft") show(current - 1);
  };

  return (
    <section className="proof" id="client-stories">
      <div className="wrap">
        <div className="proof-heading">
          <div>
            <h2>Real progress starts with the right constraint.</h2>
          </div>
          <p>
            We share client outcomes only with permission and verified details. These story cards are placeholders
            until approved case studies are added.
          </p>
        </div>
        <div
          className="story-carousel"
          aria-roledescription="carousel"
          aria-label="Client story placeholders"
          tabIndex={0}
          onKeyDown={onKeyDown}
        >
          <div className="story-track">
            {STORIES.map((s, i) => (
              <article
                key={s.tag}
                className={`story-card${i === current ? " is-active" : ""}`}
                aria-label={`Story placeholder ${i + 1} of ${count}`}
                aria-hidden={i !== current}
                hidden={i !== current}
              >
                <div className="story-top">
                  <span className="story-index">{s.tag}</span>
                  <span className="story-tag">APPROVED CASE STUDY</span>
                </div>
                <div className="story-mark">{s.mark}</div>
                <h3>{s.title}</h3>
                <p>{s.text}</p>
                <div className="story-result">
                  <span>THE OUTCOME</span>
                  <b>{s.result}</b>
                  <small>{s.note}</small>
                </div>
                <div className="story-source">Client name · Company · Industry</div>
              </article>
            ))}
          </div>
          <div className="story-controls">
            <div className="story-dots" role="group" aria-label="Choose a client story">
              {STORIES.map((s, i) => (
                <button
                  key={s.tag}
                  className={`story-dot${i === current ? " is-active" : ""}`}
                  type="button"
                  aria-label={`Show story ${i + 1}`}
                  aria-current={i === current ? "true" : undefined}
                  onClick={() => show(i)}
                />
              ))}
            </div>
            <div className="story-arrows">
              <button
                className="story-arrow"
                type="button"
                aria-label="Previous story"
                onClick={() => show(current - 1)}
              >
                ←
              </button>
              <button className="story-arrow" type="button" aria-label="Next story" onClick={() => show(current + 1)}>
                →
              </button>
            </div>
          </div>
          <p className="story-note">
            Illustrative content slots only. Replace with real, approved client evidence before launch.
          </p>
        </div>
      </div>
    </section>
  );
}
