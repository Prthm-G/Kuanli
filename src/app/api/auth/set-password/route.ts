// ============================================================
// POST /api/auth/set-password { password }
//
// The first-login step after a one-time password. Only works while
// the caller's app_metadata.must_change_password is set.
//
// The password changes through the member's own session: an admin
// password change would end that session (GoTrue drops sessions on
// it), and GoTrue refuses a password equal to the current one, so the
// one-time password can't be kept. Then the flag is cleared with the
// service role, which leaves the session alone.
// ============================================================

import { NextResponse } from "next/server";

import { MIN_PASSWORD_LENGTH, mustChangePassword } from "@/lib/auth/username";
import { supabaseAdmin } from "@/lib/automations/admin-client";
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from "@/lib/rate-limit";
import { createClient } from "@/lib/supabase/server";

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const limit = checkRateLimit(`set-password:${user.id}`, RATE_LIMITS.passwordSet);
  if (!limit.success) return rateLimitResponse(limit);

  if (!mustChangePassword(user)) {
    return NextResponse.json(
      { error: "No password change is pending" },
      { status: 400 },
    );
  }

  const body = (await request.json().catch(() => null)) as
    | { password?: unknown }
    | null;
  const password = body?.password;
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    return NextResponse.json(
      { error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` },
      { status: 400 },
    );
  }

  const { error: pwError } = await supabase.auth.updateUser({ password });
  if (pwError) {
    if (pwError.code === "same_password") {
      return NextResponse.json(
        { error: "Choose a new password, not the one-time password" },
        { status: 400 },
      );
    }
    if (pwError.code === "weak_password") {
      return NextResponse.json({ error: pwError.message }, { status: 400 });
    }
    console.error("[set-password] updateUser failed:", pwError);
    return NextResponse.json(
      { error: "Failed to save the password" },
      { status: 500 },
    );
  }

  const { error: flagError } = await supabaseAdmin().auth.admin.updateUserById(
    user.id,
    { app_metadata: { must_change_password: false } },
  );
  if (flagError) {
    console.error("[set-password] clearing must_change_password failed:", user.id, flagError);
    return NextResponse.json(
      {
        error:
          "Your password was saved, but setup didn't finish. Ask your admin for a new one-time password.",
      },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true });
}
