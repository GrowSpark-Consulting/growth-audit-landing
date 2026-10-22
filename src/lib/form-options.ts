/**
 * Growth Audit form answers and rules, shared by the form (browser) and server
 * validation so the two can never accept different values.
 */
export const TEAM_SIZES = ["1-5", "6-15", "16-30", "31-75", "76+"] as const;

export const INDUSTRIES = [
  "Professional services",
  "Technology & software",
  "Manufacturing",
  "Retail & e-commerce",
  "Healthcare & wellness",
  "Financial services",
  "Education & training",
  "Construction & real estate",
  "Hospitality & food",
  "Other",
] as const;

export const REVENUES = [
  "Below ₹50 lakh",
  "₹50 lakh-₹1 crore",
  "₹1-2 crore",
  "₹2-3 crore",
  "₹3-5 crore",
  "Above ₹5 crore",
] as const;

export const OTHER_CHALLENGE = "Another business challenge";

export const CHALLENGES = [
  "Revenue is growing, but profit is not",
  "Stuck at the same revenue for years",
  "My revenue is going down every year",
  OTHER_CHALLENGE,
] as const;

export const CHALLENGE_DETAILS_MAX = 300;
export const CHALLENGE_DETAILS_REQUIRED_MESSAGE = "Please describe your business challenge.";
export const CITY_MAX = 100;

/** Letters (any script), spaces and . , ' ’ - ( ); valid as an HTML pattern in u and v regex modes. */
export const CITY_HTML_PATTERN = String.raw`\s*[\p{L}\p{M}][\p{L}\p{M}\s.,'’\-\(\)]*\s*`;
const CITY_PATTERN = /^[\p{L}\p{M}][\p{L}\p{M}\s.,'’\-()]*$/u;

/** The description box is shown, and required, only for "Another business challenge". */
export function needsChallengeDetails(challenge: string): boolean {
  return challenge === OTHER_CHALLENGE;
}

/** Choosing a different challenge discards the description so a stale one is never sent. */
export function detailsAfterChallengeChange(nextChallenge: string, details: string): string {
  return needsChallengeDetails(nextChallenge) ? details : "";
}

export function normalizeCity(raw: unknown): string {
  return typeof raw === "string" ? raw.trim().replace(/\s+/g, " ") : "";
}

export function isValidCity(city: string): boolean {
  return city.length > 0 && city.length <= CITY_MAX && CITY_PATTERN.test(city);
}

export function normalizeChallengeDetails(raw: unknown): string {
  return typeof raw === "string" ? raw.replace(/\r\n?/g, "\n").trim() : "";
}

/** The JSON body both form variants send. The description is included only when it applies. */
export function buildLeadPayload(formData: FormData) {
  const businessProblem = formData.get("businessProblem");
  const details = formData.get("challengeDetails");
  return {
    name: formData.get("name"),
    phone: formData.get("phone"),
    email: formData.get("email"),
    company: formData.get("company"),
    website: formData.get("website") || undefined,
    city: formData.get("city"),
    team: formData.get("team"),
    industry: formData.get("industry"),
    revenue: formData.get("revenue"),
    businessProblem,
    challengeDetails:
      typeof businessProblem === "string" && needsChallengeDetails(businessProblem) && details
        ? details
        : undefined,
  };
}
