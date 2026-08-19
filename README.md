# Kuanli — WhatsApp CRM for student admissions

> A self-hosted CRM built on the official WhatsApp Business API, for
> counselling teams who run their entire admissions funnel over chat.
> Shared inbox, per-university pipelines, application and document
> tracking, and an automated re-engagement engine.

[![License: MIT](https://img.shields.io/badge/License-MIT-violet.svg)](./LICENSE)
[![Next.js 16](https://img.shields.io/badge/Next.js-16-black?logo=nextdotjs)](https://nextjs.org)
[![React 19](https://img.shields.io/badge/React-19-61dafb?logo=react)](https://react.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript)](https://www.typescriptlang.org)
[![Supabase](https://img.shields.io/badge/Supabase-Postgres%20%2B%20Auth-3ecf8e?logo=supabase)](https://supabase.com)

Most CRMs assume email. Admissions counselling doesn't work that way —
the entire relationship, from first enquiry to submitted documents,
happens in WhatsApp. Kuanli is built around that: the conversation is
the record, and the pipeline, application state, and document checklist
all hang off it.

This runs in production against real applicant traffic.

## What it does

**Shared inbox.** Multiple counsellors working one WhatsApp number,
with per-conversation assignment, status, internal notes, and reply
quoting. Multiple business numbers per account are supported, and each
contact keeps a separate thread per number.

**Pipelines.** Kanban deal boards with a distinct pipeline per
university, so an applicant to one institution moves through that
institution's stages without polluting another's funnel. Board, funnel,
and activity views.

**Lead queue.** Segmented work queue so counsellors always have a
defined next action instead of scrolling the inbox.

**Applications and documents.** Collects marksheets and ID documents
over WhatsApp against a per-university required-document checklist,
tracks each one's verification state, and archives verified files into
a private, account-scoped storage bucket rather than leaving them to
expire in Meta's media store.

**Follow-up engine.** A configurable re-engagement ladder that nudges
silent leads on a delay schedule. Rungs fire at most once per silence
spell, with a spacing guard and a per-run cap — over-messaging degrades
a number's quality rating with Meta, which throttles every send
including human replies, so the limits are deliberate.

**Broadcasts.** Meta-approved templates with per-recipient variable
substitution, plus delivery and read tracking.

**Automations and flows.** A visual builder with triggers on inbound
messages, keywords, new contacts, tag changes, and schedules;
conditional branches, waits, tagging, and webhooks.

**Reporting.** Funnel analytics by stage, response times, daily volume,
and a scheduled end-of-day summary mailer.

**Bot bridge.** A documented seam for an external AI agent to answer
inbound messages and write back into the CRM, with a per-conversation
mute so a human can take over a thread mid-conversation and the bot
stays out of it.

**Team accounts.** Invite by link, roles (owner / admin / agent /
viewer), ownership transfer, and account-scoped row-level security on
every table.

## Stack

- **App** — Next.js 16 (App Router), React 19, TypeScript (strict), Tailwind v4
- **Data** — Supabase: Postgres, Auth, Storage, RLS on every table
- **WhatsApp** — Meta Cloud API (official WhatsApp Business API)
- **Tests** — Vitest, colocated with source

## Running it

```bash
git clone https://github.com/Prthm-G/wacrm.git
cd wacrm
npm install
cp .env.local.example .env.local   # Supabase + Meta credentials
npm run dev
```

Open <http://localhost:3000>; you'll land on `/login`.

Apply the SQL in `supabase/migrations/` against your Supabase project in
filename order before first run. Migrations are numbered and each header
documents its rationale and rollback.

```bash
npm run test       # vitest
npm run typecheck  # tsc --noEmit
npm run lint       # eslint
npm run build      # production build
```

## Security

RLS is enforced on every table, WhatsApp tokens are encrypted at rest
(AES-256-GCM), webhooks are HMAC-verified, and privilege columns on
`profiles` are guarded at the database layer so membership can only
change through supervised, `SECURITY DEFINER` RPCs.

Found a vulnerability? Please follow [`.github/SECURITY.md`](./.github/SECURITY.md)
and report it privately rather than opening a public issue.

## Credits

Kuanli began as a fork of [ArnasDon/wacrm](https://github.com/ArnasDon/wacrm),
an MIT-licensed self-hostable WhatsApp CRM template by Arnas Donauskas,
and has since diverged substantially — the admissions domain model
(university pipelines, applications, documents, lead queue, follow-up
engine, reporting) is specific to this project. Credit for the original
foundation belongs upstream; if you want a general-purpose WhatsApp CRM
template rather than an admissions-shaped one, start there.

## License

[MIT](./LICENSE) — copyright Pratham Goel, and Arnas Donauskas for the
original template.
