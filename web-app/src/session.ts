export type Screen = "loading" | "signed-in" | "signed-out" | "expired";
type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export function codeFrom(hash: string): string | null {
  return new URLSearchParams(hash.replace(/^#/, "")).get("code");
}

/** Trade the one-time code for a cookie, or fall back to an existing cookie. */
export async function startSession(hash: string, fetchFn: Fetch): Promise<Screen> {
  try {
    const code = codeFrom(hash);
    if (code) {
      const r = await fetchFn("/web/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code }),
      });
      if (r.ok) return "signed-in";
    }
    if ((await fetchFn("/web/me")).ok) return "signed-in";
    return code ? "expired" : "signed-out";
  } catch {
    return "signed-out";
  }
}
