// ============================================================
// POST /api/reports/eod
//
// Sends the end-of-day report by email. Scheduled externally —
// the n8n workflow "Kuanli EOD Report" calls this at 17:00 IST
// daily — so the schedule lives with the rest of the automation
// and this route stays a plain, testable trigger.
//
// Auth is the same shared-secret pattern as /api/automations/cron:
// `x-cron-secret` must match EOD_REPORT_SECRET. There is no user
// session on a cron call, so the query runs through the service-
// role client and is scoped explicitly by account_id rather than
// by RLS.
//
// Email goes out through the same SMTP transport the invite flow
// already uses, so no new credential is involved and n8n never
// needs SMTP access of its own.
// ============================================================

import { NextResponse } from "next/server";
import nodemailer from "nodemailer";

import { supabaseAdmin } from "@/lib/automations/admin-client";
import { loadEodReport } from "@/lib/reports/queries";
import { renderEodEmail } from "@/lib/reports/email";
import { resolveRange, describeRange, type EodPeriod } from "@/lib/reports/period";

const PERIODS: EodPeriod[] = ["day", "week", "month"];

export async function POST(request: Request) {
  const expected = process.env.EOD_REPORT_SECRET;
  if (!expected) {
    return NextResponse.json({ error: "EOD report not configured" }, { status: 503 });
  }
  if (request.headers.get("x-cron-secret") !== expected) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const requested = url.searchParams.get("period") as EodPeriod | null;
  const period: EodPeriod =
    requested && PERIODS.includes(requested) ? requested : "day";

  const db = supabaseAdmin();

  // One report per account, addressed to that account's owner, so a
  // multi-account deploy does not leak one tenant's leads to another.
  // EOD_REPORT_TO overrides the recipient for a single-tenant setup.
  const { data: accounts, error: accErr } = await db.from("accounts").select("id, name");
  if (accErr) {
    return NextResponse.json({ error: accErr.message }, { status: 500 });
  }

  const override = process.env.EOD_REPORT_TO?.trim();
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "");
  const rangeLabel = describeRange(resolveRange(period));
  const sent: string[] = [];
  const skipped: string[] = [];

  for (const account of accounts ?? []) {
    let to = override;
    if (!to) {
      const { data: owner } = await db
        .from("profiles")
        .select("email")
        .eq("account_id", account.id)
        .eq("account_role", "owner")
        .limit(1)
        .maybeSingle();
      to = owner?.email ?? undefined;
    }
    if (!to) {
      skipped.push(`${account.id}: no recipient`);
      continue;
    }

    const report = await loadEodReport(db, account.id as string, period);
    const { subject, text, html } = renderEodEmail(
      report,
      rangeLabel,
      siteUrl ? `${siteUrl}/reports` : null,
    );

    try {
      await transport().sendMail({
        from: `${process.env.SMTP_SENDER_NAME || "Kuanli CRM"} <${process.env.SMTP_ADMIN_EMAIL}>`,
        to,
        subject,
        text,
        html,
      });
      sent.push(account.id as string);
    } catch (err) {
      // One account's SMTP failure must not abort the rest of the run.
      console.error("[eod] send failed for account", account.id, err);
      skipped.push(`${account.id}: send failed`);
    }
  }

  return NextResponse.json({ ok: true, period, rangeLabel, sent, skipped });
}

function transport() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST!,
    port: Number(process.env.SMTP_PORT ?? 465),
    secure: true,
    auth: { user: process.env.SMTP_USER!, pass: process.env.SMTP_PASS! },
  });
}
