"use client";

import { useEffect, useState } from "react";

const STORAGE_KEY = "growspark_offer_cycle";
const MIN_START_SECONDS = 26 * 60;
const MAX_START_SECONDS = 28 * 60;
const RESTART_AT_SECONDS = 12 * 60;

type Cycle = { end: number; total: number };

/** New cycle: a random start between 26:00 and 28:00, counting down in real time. */
function newCycle(now: number): Cycle {
  const total = MIN_START_SECONDS + Math.floor(Math.random() * (MAX_START_SECONDS - MIN_START_SECONDS + 1));
  return { end: now + total * 1000, total };
}

function loadCycle(): Cycle | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Cycle>;
    if (Number.isFinite(parsed.end) && Number.isFinite(parsed.total)) return parsed as Cycle;
  } catch {
    /* storage unavailable or corrupt */
  }
  return null;
}

function saveCycle(cycle: Cycle) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cycle));
  } catch {
    /* storage unavailable: timer still works for this session */
  }
}

const secondsLeft = (cycle: Cycle, now: number) => Math.ceil((cycle.end - now) / 1000);

export function CountdownTimer() {
  const [time, setTime] = useState<{ left: number; total: number } | null>(null);

  useEffect(() => {
    // The saved end time is absolute, so a returning visitor continues where the timer
    // would have got to. Once it reaches 12:00 (also while the tab was closed) it restarts.
    let cycle = loadCycle();
    const startCycle = (now: number) => {
      cycle = newCycle(now);
      saveCycle(cycle);
    };
    if (!cycle || secondsLeft(cycle, Date.now()) <= RESTART_AT_SECONDS) startCycle(Date.now());

    let id: number;
    const tick = () => {
      const now = Date.now();
      if (!cycle || secondsLeft(cycle, now) <= RESTART_AT_SECONDS) startCycle(now);
      setTime({ left: secondsLeft(cycle!, now), total: cycle!.total });
      id = window.setTimeout(tick, 250);
    };
    id = window.setTimeout(tick, 0);
    return () => window.clearTimeout(id);
  }, []);

  const left = time?.left ?? null;
  const total = time?.total ?? 1;
  const expired = false;
  const digits =
    left === null
      ? null
      : String(Math.floor(left / 60)).padStart(2, "0") + String(left % 60).padStart(2, "0");

  return (
    <header className={`topbar countdown-top${expired ? " is-expired" : ""}`}>
      <div className="countdown-bar">
        <span className="countdown-caption" id="countdownCaption" hidden={expired}>
          TIME LEFT TO UNLOCK THE ₹10,000 AUDIT OFFER
        </span>
        <strong
          className="countdown-clock"
          id="offerTimer"
          role="timer"
          aria-live="off"
          aria-label="Time remaining on this offer"
        >
          {digits && (
            <>
              <span className="timer-digit">{digits[0]}</span>
              <span className="timer-digit">{digits[1]}</span>
              <span className="timer-colon">:</span>
              <span className="timer-digit">{digits[2]}</span>
              <span className="timer-digit">{digits[3]}</span>
            </>
          )}
        </strong>
        <span className="countdown-expired" id="countdownExpired" hidden={!expired}>
          This offer window has ended
        </span>
        <div className="timer-track" aria-hidden="true">
          <span
            id="timerProgress"
            style={{ width: left === null ? undefined : `${(left / total) * 100}%` }}
          />
        </div>
      </div>
    </header>
  );
}
