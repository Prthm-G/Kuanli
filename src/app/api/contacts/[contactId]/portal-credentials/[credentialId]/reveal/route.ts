import { NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/automations/admin-client";
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from "@/lib/rate-limit";
import { decrypt } from "@/lib/whatsapp/encryption";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Reveal one saved portal password (migration 072). The ONLY route that
 * returns plaintext.
 *
 * Order is load-bearing: the audit row is inserted BEFORE the plaintext is
 * returned, and an insert failure aborts the reveal — an un-audited reveal
 * is impossible by construction. Rate-limited per user to bound bulk
 * exfiltration from a compromised counsellor session.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ contactId: string; credentialId: string }> },
) {
  try {
    const ctx = await requireRole("agent");

    const limit = checkRateLimit(
      `credential-reveal:${ctx.userId}`,
      RATE_LIMITS.credentialReveal,
    );
    if (!limit.success) return rateLimitResponse(limit);

    const { contactId, credentialId } = await params;
    if (!UUID_RE.test(contactId) || !UUID_RE.test(credentialId)) {
      return NextResponse.json({ error: "Invalid id" }, { status: 400 });
    }

    // Membership proof: the contact is only visible under the caller's RLS.
    const { data: contact } = await ctx.supabase
      .from("contacts")
      .select("id, account_id")
      .eq("id", contactId)
      .maybeSingle();
    if (!contact) {
      return NextResponse.json({ error: "Contact not found" }, { status: 404 });
    }

    const { data: credential } = await supabaseAdmin()
      .from("student_portal_credentials")
      .select("id, label, account_id, password_ciphertext")
      .eq("id", credentialId)
      .eq("contact_id", contactId)
      .maybeSingle();
    if (!credential) {
      return NextResponse.json(
        { error: "Credential not found" },
        { status: 404 },
      );
    }

    const { error: auditError } = await supabaseAdmin()
      .from("student_portal_credential_reveals")
      .insert({
        account_id: credential.account_id,
        contact_id: contactId,
        credential_id: credentialId,
        credential_label: credential.label,
        revealed_by: ctx.userId,
      });
    if (auditError) {
      console.error("[portal-credentials] reveal audit failed:", auditError);
      return NextResponse.json(
        { error: "Failed to record the reveal — password not shown" },
        { status: 500 },
      );
    }

    let password: string;
    try {
      password = decrypt(credential.password_ciphertext as string);
    } catch (err) {
      console.error("[portal-credentials] decrypt failed:", err);
      return NextResponse.json(
        { error: "Stored password could not be decrypted — re-save it" },
        { status: 500 },
      );
    }

    return NextResponse.json({ password });
  } catch (error) {
    return toErrorResponse(error);
  }
}
