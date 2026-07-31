import { NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from "@/lib/rate-limit";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Permanently delete one conversation and its message history.
 *
 * Migration 028 changes deals.conversation_id to ON DELETE SET NULL, so
 * linked CRM deals survive. RLS and the explicit account predicate prevent
 * cross-account deletion even if a caller guesses a valid UUID.
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ conversationId: string }> },
) {
  try {
    const ctx = await requireRole("agent");
    const limit = checkRateLimit(
      `conversation:delete:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    );
    if (!limit.success) return rateLimitResponse(limit);

    const { conversationId } = await params;
    if (!UUID_RE.test(conversationId)) {
      return NextResponse.json(
        { error: "Invalid conversation id" },
        { status: 400 },
      );
    }

    const { error, count } = await ctx.supabase
      .from("conversations")
      .delete({ count: "exact" })
      .eq("id", conversationId)
      .eq("account_id", ctx.accountId);

    if (error) {
      if (error.code === "23503") {
        return NextResponse.json(
          { error: "The conversation still has a protected linked record" },
          { status: 409 },
        );
      }
      console.error("[conversation delete] database error:", error);
      return NextResponse.json(
        { error: "Failed to delete conversation" },
        { status: 500 },
      );
    }

    if (count === 0) {
      return NextResponse.json(
        { error: "Conversation not found" },
        { status: 404 },
      );
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    return toErrorResponse(error);
  }
}
