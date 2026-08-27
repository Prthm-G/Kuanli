import type { EodReport, EodRow } from "./types";
import { isPlaceholderRoll } from "./types";

/**
 * Render the EOD report as an email.
 *
 * Kept as a pure function so the layout is testable without SMTP. The HTML is
 * deliberately table-and-inline-styles only: Gmail and Outlook strip <style>
 * blocks, and this has to survive both.
 */
export function renderEodEmail(
  report: EodReport,
  rangeLabel: string,
  reportUrl: string | null,
): { subject: string; text: string; html: string } {
  const { rows, summary, followups } = report;
  const subject = `Kuanli EOD · ${rangeLabel} · ${summary.total} new conversation${
    summary.total === 1 ? "" : "s"
  }`;

  const dash = (v: string | null) => v || "—";
  const roll = (r: EodRow) => (isPlaceholderRoll(r.rollNumber) ? "—" : r.rollNumber!);

  const text = [
    `Kuanli EOD report — ${rangeLabel}`,
    "",
    `New conversations : ${summary.total}`,
    `University known  : ${summary.withUniversity}`,
    `Course known      : ${summary.withCourse}`,
    `Roll number issued: ${summary.enrolled}`,
    `Follow-ups logged : ${followups.logged}`,
    `Still overdue     : ${followups.overdue}`,
    "",
    ...rows.map(
      (r) =>
        `${dash(r.phone)}  ${dash(r.name)}  ${dash(r.university)}  ${dash(
          r.mode,
        )}  ${dash(r.course)}  ${roll(r)}`,
    ),
    "",
    reportUrl ? `Full report: ${reportUrl}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const th = 'style="text-align:left;padding:6px 10px;font-size:12px;color:#666;border-bottom:1px solid #ddd;"';
  const td = 'style="padding:6px 10px;font-size:13px;border-bottom:1px solid #f0f0f0;"';

  const body = rows.length
    ? `<table cellspacing="0" cellpadding="0" style="width:100%;border-collapse:collapse;">
        <tr>
          <th ${th}>Phone</th><th ${th}>Name</th><th ${th}>University</th>
          <th ${th}>Mode</th><th ${th}>Course</th><th ${th}>Roll no.</th>
        </tr>
        ${rows
          .map(
            (r) => `<tr>
            <td ${td}>${esc(dash(r.phone))}</td>
            <td ${td}>${esc(dash(r.name))}</td>
            <td ${td}>${esc(dash(r.university))}</td>
            <td ${td}>${esc(dash(r.mode))}</td>
            <td ${td}>${esc(dash(r.course))}</td>
            <td ${td}>${esc(roll(r))}</td>
          </tr>`,
          )
          .join("")}
      </table>`
    : `<p style="color:#666;">No new conversations in this period.</p>`;

  const stat = (label: string, value: number) =>
    `<td style="padding:8px 12px;border:1px solid #eee;border-radius:6px;">
       <div style="font-size:11px;color:#666;">${label}</div>
       <div style="font-size:20px;font-weight:600;">${value}</div>
     </td>`;

  const html = `<div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:760px;margin:0 auto;color:#111;">
    <h2 style="margin:0 0 4px;">Kuanli EOD report</h2>
    <p style="margin:0 0 16px;color:#666;font-size:13px;">${esc(rangeLabel)}</p>
    <table cellspacing="8" cellpadding="0"><tr>
      ${stat("New conversations", summary.total)}
      ${stat("University known", summary.withUniversity)}
      ${stat("Course known", summary.withCourse)}
      ${stat("Roll number issued", summary.enrolled)}
    </tr><tr>
      ${stat("Follow-ups logged", followups.logged)}
      ${stat("Still overdue", followups.overdue)}
    </tr></table>
    <div style="height:16px"></div>
    ${body}
    ${
      reportUrl
        ? `<p style="margin-top:20px;">
             <a href="${esc(reportUrl)}" style="display:inline-block;padding:9px 16px;background:#111;color:#fff;text-decoration:none;border-radius:6px;font-size:13px;">
               Open in Kuanli
             </a>
           </p>`
        : ""
    }
  </div>`;

  return { subject, text, html };
}

/** Escape for HTML interpolation. Lead names and course text are user input. */
function esc(v: string): string {
  return v
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
