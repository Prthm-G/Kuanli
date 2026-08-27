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

/** See ../route.ts for the shared authorization pattern. */
async function authorize(contactId: string, credentialId: string) {
  const ctx = await requireRole("agent");

  if (!UUID_RE.test(contactId) || !UUID_RE.test(credentialId)) {
    return { response: NextResponse.json({ error: "Invalid id" }, { status: 400 }) };
  }

  const { data: contact } = await ctx.supabase
    .from("contacts")
    .select("id, account_id")
    .eq("id", contactId)
    .maybeSingle();
  if (!contact) {
    return {
      response: NextResponse.json({ error: "Contact not found" }, { status: 404 }),
    };
  }

  const { data: credential } = await supabaseAdmin()
    .from("student_portal_credentials")
    .select("id, label, account_id")
    .eq("id", credentialId)
    .eq("contact_id", contactId)
    .maybeSingle();
  if (!credential) {
    return {
      response: NextResponse.json(
        { error: "Credential not found" },
        { status: 404 },
      ),
    };
  }

  return {
    ctx,
    contact: contact as { id: string; account_id: string },
    credential: credential as { id: string; label: string; account_id: string },
  };
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ contactId: string; credentialId: string }> },
) {
  try {
    const { contactId, credentialId } = await params;
    const auth = await authorize(contactId, credentialId);
    if ("response" in auth) return auth.response;

    const body = (await request.json().catch(() => null)) as unknown;
    const parsed = validateCredentialInput(body, { partial: true });
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }

    const update: Record<string, unknown> = {
      updated_by: auth.ctx.userId,
      updated_at: new Date().toISOString(),
    };
    if (parsed.value.label !== undefined) update.label = parsed.value.label;
    if (parsed.value.portal_url !== undefined)
      update.portal_url = parsed.value.portal_url;
    if (parsed.value.username !== undefined)
      update.username = parsed.value.username;
    if (parsed.value.notes !== undefined) update.notes = parsed.value.notes;
    if (parsed.value.password !== undefined) {
      try {
        update.password_ciphertext = encrypt(parsed.value.password);
      } catch (err) {
        console.error("[portal-credentials] encryption failed:", err);
        return NextResponse.json(
          { error: "Encryption failed — check ENCRYPTION_KEY" },
          { status: 500 },
        );
      }
    }

    const { data, error } = await supabaseAdmin()
      .from("student_portal_credentials")
      .update(update)
      .eq("id", credentialId)
      .select(CREDENTIAL_SELECT_COLUMNS)
      .single();

    if (error || !data) {
      console.error("[portal-credentials] update failed:", error);
      return NextResponse.json(
        { error: "Failed to update credential" },
        { status: 500 },
      );
    }

    return NextResponse.json({
      credential: toMetadata(data as Record<string, unknown>),
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ contactId: string; credentialId: string }> },
) {
  try {
    const { contactId, credentialId } = await params;
    const auth = await authorize(contactId, credentialId);
    if ("response" in auth) return auth.response;

    // Reveal-audit rows survive: credential_id goes NULL on delete and the
    // label/contact snapshots keep the trail meaningful (migration 072).
    const { error } = await supabaseAdmin()
      .from("student_portal_credentials")
      .delete()
      .eq("id", credentialId);

    if (error) {
      console.error("[portal-credentials] delete failed:", error);
      return NextResponse.json(
        { error: "Failed to delete credential" },
        { status: 500 },
      );
    }

    return NextResponse.json({ deleted: true });
  } catch (error) {
    return toErrorResponse(error);
  }
}
