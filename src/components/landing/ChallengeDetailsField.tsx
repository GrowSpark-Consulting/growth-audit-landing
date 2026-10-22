import { CHALLENGE_DETAILS_MAX } from "@/lib/form-options";

interface ChallengeDetailsFieldProps {
  value: string;
  error: string | null;
  disabled: boolean;
  onChange: (value: string, field: HTMLTextAreaElement) => void;
  onInvalid: () => void;
}

/** Shown below the challenge dropdown only when "Another business challenge" is selected. */
export function ChallengeDetailsField({ value, error, disabled, onChange, onInvalid }: ChallengeDetailsFieldProps) {
  return (
    <div className="field full">
      <label htmlFor="challengeDetails">Please describe your business challenge *</label>
      <textarea
        id="challengeDetails"
        name="challengeDetails"
        rows={3}
        maxLength={CHALLENGE_DETAILS_MAX}
        placeholder="Briefly describe your main business challenge..."
        required
        value={value}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? "challengeDetails-count challengeDetails-error" : "challengeDetails-count"}
        onChange={(event) => onChange(event.target.value, event.target)}
        onInvalid={(event) => {
          // Show the message inline under the field instead of the browser's bubble.
          event.preventDefault();
          onInvalid();
        }}
      />
      <div className="field-meta">
        {error ? (
          <span className="field-error" id="challengeDetails-error" role="alert">
            {error}
          </span>
        ) : (
          <span />
        )}
        <span id="challengeDetails-count">
          {value.length}/{CHALLENGE_DETAILS_MAX}
        </span>
      </div>
    </div>
  );
}
