import { NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/automations/admin-client";
import {
  CREDENTIAL_SELECT_COLUMNS,
  toMetadata,
  validateCredentialInput,
} from "@/lib/contacts/portal-credentials";
import { encrypt } from "@/lib/whatsapp/encryption";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Student portal credentials for one contact (migration 072).
 *
 * The credentials table is deny-all through PostgREST, so this route is the
 * ONLY read/write surface. Authorization pattern shared by every handler:
 *   1. requireRole('agent') — counsellor or higher, 401/403 otherwise.
 *   2. Resolve the contact with the CALLER's RLS client; a contact outside
 *      the caller's account is invisible, so a hit doubles as the
 *      membership proof. 404 otherwise.
 *   3. Only then touch student_portal_credentials via the service client,
 *      scoping by contact_id and deriving account_id from the contact row —
 *      never from the request body.
 * Responses are built via toMetadata, so ciphertext can never serialize.
 */
async function resolveContact(
  ctx: Awaited<ReturnType<typeof requireRole>>,
  contactId: string,
) {
  const { data } = await ctx.supabase
    .from("contacts")
    .select("id, account_id")
    .eq("id", contactId)
    .maybeSingle();
  return data as { id: string; account_id: string } | null;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ contactId: string }> },
) {
  try {
    const ctx = await requireRole("agent");

    const { contactId } = await params;
    if (!UUID_RE.test(contactId)) {
      return NextResponse.json({ error: "Invalid contact id" }, { status: 400 });
    }

    const contact = await resolveContact(ctx, contactId);
    if (!contact) {
      return NextResponse.json({ error: "Contact not found" }, { status: 404 });
    }

    const { data, error } = await supabaseAdmin()
      .from("student_portal_credentials")
      .select(CREDENTIAL_SELECT_COLUMNS)
      .eq("contact_id", contactId)
      .order("created_at", { ascending: true });

    if (error) {
      console.error("[portal-credentials] list failed:", error);
      return NextResponse.json(
        { error: "Failed to load credentials" },
        { status: 500 },
      );
    }

    return NextResponse.json({
      credentials: (data ?? []).map((row) =>
        toMetadata(row as Record<string, unknown>),
      ),
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ contactId: string }> },
) {
  try {
    const ctx = await requireRole("agent");

    const { contactId } = await params;
    if (!UUID_RE.test(contactId)) {
      return NextResponse.json({ error: "Invalid contact id" }, { status: 400 });
    }

    const body = (await request.json().catch(() => null)) as unknown;
    const parsed = validateCredentialInput(body, { partial: false });
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }

    const contact = await resolveContact(ctx, contactId);
    if (!contact) {
      return NextResponse.json({ error: "Contact not found" }, { status: 404 });
    }

    let ciphertext: string;
    try {
      ciphertext = encrypt(parsed.value.password!);
    } catch (err) {
      console.error("[portal-credentials] encryption failed:", err);
      return NextResponse.json(
        { error: "Encryption failed — check ENCRYPTION_KEY" },
        { status: 500 },
      );
    }

    const { data, error } = await supabaseAdmin()
      .from("student_portal_credentials")
      .insert({
        account_id: contact.account_id,
        contact_id: contactId,
        label: parsed.value.label,
        portal_url: parsed.value.portal_url ?? null,
        username: parsed.value.username ?? null,
        password_ciphertext: ciphertext,
        notes: parsed.value.notes ?? null,
        created_by: ctx.userId,
      })
      .select(CREDENTIAL_SELECT_COLUMNS)
      .single();

    if (error || !data) {
      console.error("[portal-credentials] insert failed:", error);
      return NextResponse.json(
        { error: "Failed to save credential" },
        { status: 500 },
      );
    }

    return NextResponse.json(
      { credential: toMetadata(data as Record<string, unknown>) },
      { status: 201 },
    );
  } catch (error) {
    return toErrorResponse(error);
  }
}
