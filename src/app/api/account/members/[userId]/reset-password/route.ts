// ============================================================
// POST /api/account/members/[userId]/reset-password — Admin+.
//
// Issues a new one-time password for a member of the caller's
// account, shown to the admin once. The member is signed out
// everywhere and must choose a new password at next sign-in.
// Not for the owner or for yourself (Settings → Password).
// ============================================================

import { NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import {
  MemberLoginError,
  resetMemberPassword,
} from "@/lib/auth/member-logins";
import { supabaseAdmin } from "@/lib/automations/admin-client";
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from "@/lib/rate-limit";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ userId: string }> },
) {
  try {
    const ctx = await requireRole("admin");

    const limit = checkRateLimit(
      `admin:memberReset:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    );
    if (!limit.success) return rateLimitResponse(limit);

    const { userId } = await params;
    const issued = await resetMemberPassword(supabaseAdmin(), {
      accountId: ctx.accountId,
      callerUserId: ctx.userId,
      targetUserId: userId,
    });
    return NextResponse.json({ login: issued.login, password: issued.password });
  } catch (err) {
    if (err instanceof MemberLoginError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return toErrorResponse(err);
  }
}
