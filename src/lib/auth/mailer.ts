// ============================================================
// Minimal SMTP mailer for auth emails this app sends itself.
//
// GoTrue's own mailer only fires for its public /signup endpoint,
// which is disabled (GOTRUE_DISABLE_SIGNUP=true) so that account
// creation can be gated server-side on a valid invite token first
// (see /api/auth/invited-signup). Since GoTrue never sees that
// signup, it never sends the confirmation email either - so this
// app has to send it, reusing the same SMTP credentials GoTrue's
// container already uses (SMTP_* here is the plain, non-GOTRUE_-
// prefixed set in .env, not otherwise wired to any container).
// ============================================================

import nodemailer from "nodemailer";

function getTransport() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST!,
    port: Number(process.env.SMTP_PORT ?? 465),
    secure: true,
    auth: {
      user: process.env.SMTP_USER!,
      pass: process.env.SMTP_PASS!,
    },
  });
}

export async function sendSignupConfirmationEmail(
  email: string,
  confirmationLink: string,
) {
  const transport = getTransport();
  const senderName = process.env.SMTP_SENDER_NAME || "Kuanli CRM";
  const from = `${senderName} <${process.env.SMTP_ADMIN_EMAIL}>`;

  await transport.sendMail({
    from,
    to: email,
    subject: "Confirm your Kuanli account",
    text: `Confirm your account to finish joining your team:\n\n${confirmationLink}\n\nIf you didn't request this, you can ignore this email.`,
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
        <h2>Confirm your account</h2>
        <p>Click below to confirm your email and finish joining your team.</p>
        <p>
          <a href="${confirmationLink}" style="display:inline-block;padding:10px 20px;background:#111;color:#fff;text-decoration:none;border-radius:6px;">
            Confirm account
          </a>
        </p>
        <p style="color:#666;font-size:13px;">If you didn't request this, you can ignore this email.</p>
      </div>
    `,
  });
}
