// ============================================================
// POST /api/auth/invited-signup
//
// Public — no session required (this IS how a brand-new user
// gets their first session). This is the actual server-side
// enforcement of "signups are invite-only": it validates the
// invite token via peek_invitation BEFORE creating any auth
// user, then creates the account via the admin API rather than
// the public self-serve signup endpoint (GOTRUE_DISABLE_SIGNUP=
// true disables that endpoint entirely — see docker-compose.yml).
//
// The old client-side-only gate in signup/page.tsx (redirecting
// away when `?invite=` is missing) only ever hid the form; a
// direct call to Supabase's public /auth/v1/signup could still
// create an account with no invite at all. This route is the fix.
//
// Email still requires verification before the account can be used
// (matching the original pre-invite-only behavior): the user is
// created unconfirmed, and this route sends the confirmation email
// itself via sendSignupConfirmationEmail, since GoTrue only sends
// that email for its own public /signup endpoint, which is disabled.
// The confirmation link points back at /join/<token> so the user
// lands on the redeem step immediately after verifying.
// ============================================================

import { NextResponse } from "next/server";

import { hashInviteToken } from "@/lib/auth/invitations";
import { sendSignupConfirmationEmail } from "@/lib/auth/mailer";
import { supabaseAdmin } from "@/lib/automations/admin-client";
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from "@/lib/rate-limit";
import { createClient } from "@/lib/supabase/server";

function getClientIp(request: Request): string {
  const xff = request.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  const xri = request.headers.get("x-real-ip");
  if (xri) return xri.trim();
  return "unknown";
}

export async function POST(request: Request) {
  const ip = getClientIp(request);
  const limit = checkRateLimit(
    `invited-signup:${ip}`,
    RATE_LIMITS.invitationRedeem,
  );
  if (!limit.success) return rateLimitResponse(limit);

  const body = (await request.json().catch(() => null)) as
    | {
        token?: unknown;
        email?: unknown;
        password?: unknown;
        fullName?: unknown;
      }
    | null;

  const token = body?.token;
  const email = body?.email;
  const password = body?.password;
  const fullName = body?.fullName;

  if (typeof token !== "string" || !token) {
    return NextResponse.json(
      { error: "Missing invitation token" },
      { status: 400 },
    );
  }
  if (typeof email !== "string" || !email) {
    return NextResponse.json({ error: "Missing email" }, { status: 400 });
  }
  if (typeof password !== "string" || password.length < 6) {
    return NextResponse.json(
      { error: "Password must be at least 6 characters" },
      { status: 400 },
    );
  }

  // Validate the invite BEFORE creating anything.
  const supabase = await createClient();
  const { data: peekData, error: peekError } = await supabase.rpc(
    "peek_invitation",
    { p_token_hash: hashInviteToken(token) },
  );

  if (peekError) {
    console.error("[invited-signup] peek_invitation error:", peekError);
    return NextResponse.json(
      { error: "Failed to validate invitation" },
      { status: 500 },
    );
  }

  const peek = peekData as { ok: boolean; reason?: string } | null;
  if (!peek?.ok) {
    const reason =
      peek?.reason === "used"
        ? "This invitation has already been used."
        : peek?.reason === "expired"
          ? "This invitation has expired."
          : "This invitation link is invalid.";
    return NextResponse.json({ error: reason }, { status: 400 });
  }

  // Invite is valid — create the account (unconfirmed) via the admin
  // API and get a real confirmation link via generateLink. Public
  // self-serve signup is disabled at the GoTrue level, so this is
  // the only remaining way to create a user; generateLink both
  // creates the user and returns the same kind of link GoTrue would
  // otherwise have emailed on its own for a public signup.
  const redirectTo = `${process.env.NEXT_PUBLIC_SITE_URL}/join/${encodeURIComponent(token)}`;
  const { data: linkData, error: createError } =
    await supabaseAdmin().auth.admin.generateLink({
      type: "signup",
      email,
      password,
      options: {
        data: { full_name: typeof fullName === "string" ? fullName : "" },
        redirectTo,
      },
    });

  if (createError) {
    const message = createError.message?.includes("already been registered")
      ? "An account with this email already exists. Try signing in instead."
      : createError.message || "Failed to create account";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  const actionLink = linkData?.properties?.action_link;
  if (!actionLink) {
    console.error("[invited-signup] generateLink returned no action_link");
    return NextResponse.json(
      { error: "Failed to prepare confirmation email" },
      { status: 500 },
    );
  }

  try {
    await sendSignupConfirmationEmail(email, actionLink);
  } catch (mailErr) {
    console.error("[invited-signup] failed to send confirmation email:", mailErr);
    return NextResponse.json(
      { error: "Account created, but the confirmation email failed to send. Contact your administrator." },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true });
}
