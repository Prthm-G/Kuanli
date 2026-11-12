// ============================================================
// Usernames and the password-change gate. Pure, no Supabase, no
// Node APIs: the login page and middleware (edge) import it too.
//
// Members sign in with a username, not an email. GoTrue only knows
// emails, so a username is stored as the login email
// `<username>@users.kuanli.invalid`. `.invalid` is reserved (RFC 2606)
// and never resolves, so no mail can ever go to one of these addresses.
// Existing logins keep their password hash: moving a member to a
// username only rewrites their auth email.
//
// A new or reset login gets a one-time password and
// `app_metadata.must_change_password = true`. Middleware holds that
// member on /set-password until they choose their own.
// ============================================================

export const LOGIN_EMAIL_DOMAIN = "users.kuanli.invalid";

/** Shortest password a member may choose. Matches Settings → Password. */
export const MIN_PASSWORD_LENGTH = 8;

const USERNAME_RE = /^[a-z0-9](?:[a-z0-9._-]{1,30})[a-z0-9]$/;

/**
 * Lower-cases and trims a typed username. Returns null unless it is
 * 3-32 characters of a-z, 0-9, dot, underscore or dash, starting and
 * ending with a letter or digit.
 */
export function normalizeUsername(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const u = raw.trim().toLowerCase();
  return USERNAME_RE.test(u) ? u : null;
}

export function usernameToEmail(username: string): string {
  return `${username}@${LOGIN_EMAIL_DOMAIN}`;
}

/** The username behind a login email, or null for a real email. */
export function emailToUsername(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.lastIndexOf("@");
  if (at <= 0) return null;
  if (email.slice(at + 1).toLowerCase() !== LOGIN_EMAIL_DOMAIN) return null;
  return email.slice(0, at).toLowerCase();
}

/**
 * What the login box sends to GoTrue. A username maps to its login
 * email; anything with an "@" passes through, so a member who still
 * has an email login can sign in with it.
 */
export function loginEmailFor(input: string): string | null {
  const t = input.trim();
  if (!t) return null;
  if (t.includes("@")) return t.toLowerCase();
  const u = normalizeUsername(t);
  return u ? usernameToEmail(u) : null;
}

/** How a login is shown in the UI: the username, else the email. */
export function displayLogin(email: string | null | undefined): string {
  return emailToUsername(email) ?? email ?? "";
}

/** True when this auth user must choose a password before anything else. */
export function mustChangePassword(
  user: { app_metadata?: Record<string, unknown> } | null | undefined,
): boolean {
  return user?.app_metadata?.must_change_password === true;
}

export type PasswordGate = "allow" | "to-set-password" | "forbid" | "to-dashboard";

/**
 * Middleware decision for a signed-in user. While a password change is
 * pending only the set-password page and its API are reachable; other
 * pages redirect there and other API routes get a 403. Once it is done,
 * /set-password sends them on to the dashboard.
 */
export function passwordGate(pathname: string, mustChange: boolean): PasswordGate {
  const onSetPassword =
    pathname === "/set-password" || pathname === "/api/auth/set-password";
  if (mustChange) {
    if (onSetPassword) return "allow";
    return pathname.startsWith("/api/") ? "forbid" : "to-set-password";
  }
  return pathname === "/set-password" ? "to-dashboard" : "allow";
}
