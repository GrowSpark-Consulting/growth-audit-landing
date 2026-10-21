/** eventId is the saved submission's reference, shared with the server-side Meta Lead event. */
export type FreeSubmitOutcome = { ok: true; eventId?: string } | { ok: false; message: string };

const FALLBACK_ERROR = "We could not save your request. Please review your details and try again.";

/**
 * Posts the free-page form. The server answers `{ ok: true }` only after Zoho has confirmed
 * the Lead, so success here means exactly that; every other outcome is an error.
 */
export async function submitFreeRequest(
  payload: unknown,
  fetchImpl: typeof fetch = fetch
): Promise<FreeSubmitOutcome> {
  try {
    const response = await fetchImpl("/api/free-submit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = (await response.json().catch(() => ({}))) as {
      ok?: unknown;
      eventId?: unknown;
      error?: unknown;
      errors?: unknown;
    };
    if (response.ok && data.ok === true) {
      return typeof data.eventId === "string" && data.eventId ? { ok: true, eventId: data.eventId } : { ok: true };
    }
    if (typeof data.error === "string" && data.error) return { ok: false, message: data.error };
    if (Array.isArray(data.errors) && data.errors.length) {
      return { ok: false, message: data.errors.join(" ") };
    }
    return { ok: false, message: FALLBACK_ERROR };
  } catch {
    return { ok: false, message: "Network error. Please check your connection and try again." };
  }
}
