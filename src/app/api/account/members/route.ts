// ============================================================
// GET  /api/account/members — roster.
// POST /api/account/members — add a member by username. Admin+.
//
// GET
//
// Lists every member of the caller's account. Any member can call
// it (the Members tab is shown to admins+, but agents/viewers see
// a read-only roster too).
//
// Field visibility
//   Sensitive fields (email) are returned only when the caller is
//   admin+. Agents and viewers see name + avatar + role + joined
//   date only. This mirrors the design decision from the planning
//   phase: "agent/viewer sees names only". Usernames are admin+ too.
//
// POST { username, fullName, role } → { login, password }
//   Creates the login with a one-time password, shown to the admin
//   once. A removed member's username brings their old login back
//   (see lib/auth/member-logins.ts).
// ============================================================

import { NextResponse } from "next/server";

import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from "@/lib/auth/account";
import {
  addMember,
  loginEmailsById,
  MemberLoginError,
} from "@/lib/auth/member-logins";
import { canManageMembers, isAccountRole } from "@/lib/auth/roles";
import { emailToUsername, normalizeUsername } from "@/lib/auth/username";
import { supabaseAdmin } from "@/lib/automations/admin-client";
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from "@/lib/rate-limit";
import type { AccountMember } from "@/types";

const MAX_NAME_LEN = 80;

interface ProfileRow {
  user_id: string;
  full_name: string | null;
  email: string | null;
  avatar_url: string | null;
  account_role: string;
  created_at: string;
}

export async function GET() {
  try {
    const ctx = await getCurrentAccount();

    // RLS on profiles allows reading any row whose account matches
    // the caller's, so this query is naturally account-scoped.
    const { data, error } = await ctx.supabase
      .from("profiles")
      .select("user_id, full_name, email, avatar_url, account_role, created_at")
      .eq("account_id", ctx.accountId)
      .order("created_at", { ascending: true });

    if (error) {
      console.error("[GET /api/account/members] fetch error:", error);
      return NextResponse.json(
        { error: "Failed to load members" },
        { status: 500 },
      );
    }

    const canSeeEmails = canManageMembers(ctx.role);
    // Usernames live on the auth user, not the profile.
    const loginEmails = canSeeEmails
      ? await loginEmailsById(supabaseAdmin()).catch((e: unknown) => {
          // The roster still renders without usernames.
          console.error("[GET /api/account/members] login lookup failed:", e);
          return new Map<string, string>();
        })
      : new Map<string, string>();

    const members: AccountMember[] = (data as ProfileRow[]).flatMap((row) => {
      // Defensive: the DB enum should never let an unknown role
      // through, but if a migration ever broadens the enum without
      // updating TS, skip the row rather than crash the page.
      if (!isAccountRole(row.account_role)) return [];
      return [
        {
          user_id: row.user_id,
          full_name: row.full_name ?? "",
          username: emailToUsername(loginEmails.get(row.user_id)),
          // A username member's profile email is their internal login address.
          email:
            canSeeEmails && !emailToUsername(row.email) ? row.email : null,
          avatar_url: row.avatar_url,
          role: row.account_role,
          joined_at: row.created_at,
        },
      ];
    });

    return NextResponse.json({ members });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole("admin");

    const limit = checkRateLimit(
      `admin:memberAdd:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    );
    if (!limit.success) return rateLimitResponse(limit);

    const body = (await request.json().catch(() => null)) as
      | { username?: unknown; fullName?: unknown; role?: unknown }
      | null;

    const username = normalizeUsername(body?.username);
    if (!username) {
      return NextResponse.json(
        {
          error:
            "Username must be 3-32 characters: letters, numbers, dot, dash or underscore",
        },
        { status: 400 },
      );
    }
    const fullName =
      typeof body?.fullName === "string" ? body.fullName.trim() : "";
    if (!fullName || fullName.length > MAX_NAME_LEN) {
      return NextResponse.json(
        { error: `Name is required (up to ${MAX_NAME_LEN} characters)` },
        { status: 400 },
      );
    }
    const role = body?.role;
    if (!isAccountRole(role) || role === "owner") {
      return NextResponse.json(
        { error: "'role' must be one of admin, agent, viewer" },
        { status: 400 },
      );
    }

    const issued = await addMember(supabaseAdmin(), {
      accountId: ctx.accountId,
      username,
      fullName,
      role,
    });
    return NextResponse.json({
      login: issued.login,
      password: issued.password,
      restored: issued.restored ?? false,
    });
  } catch (err) {
    if (err instanceof MemberLoginError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return toErrorResponse(err);
  }
}
