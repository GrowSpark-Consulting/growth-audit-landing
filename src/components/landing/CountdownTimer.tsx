"use client";

import { useEffect, useState } from "react";

const STORAGE_KEY = "growspark_offer_expires_at";

function readOrCreateExpiry(): number {
  let end = NaN;
  try {
    end = Number(localStorage.getItem(STORAGE_KEY));
  } catch {
    /* storage unavailable */
  }
  if (!Number.isFinite(end) || end <= Date.now()) {
    const seconds = 1081 + Math.floor(Math.random() * 119);
    end = Date.now() + seconds * 1000;
    try {
      localStorage.setItem(STORAGE_KEY, String(end));
    } catch {
      /* storage unavailable */
    }
  }
  return end;
}

export function CountdownTimer() {
  const [time, setTime] = useState<{ left: number; total: number } | null>(null);

  useEffect(() => {
    const end = readOrCreateExpiry();
    const total = Math.max(1, Math.ceil((end - Date.now()) / 1000));
    let id: number;
    const tick = () => {
      const left = Math.max(0, Math.ceil((end - Date.now()) / 1000));
      setTime({ left, total });
      if (left > 0) id = window.setTimeout(tick, 250);
    };
    id = window.setTimeout(tick, 0);
    return () => window.clearTimeout(id);
  }, []);

  const left = time?.left ?? null;
  const total = time?.total ?? 1;
  const expired = left === 0;
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
