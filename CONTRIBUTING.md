# Contributing

Kuanli is a production CRM handling real applicant conversations, not a
template to be forked and customised. Changes here are reviewed against a
live system, so the bar leans toward small, well-scoped, well-tested
changes.

## Running it locally

```bash
git clone https://github.com/Prthm-G/Kuanli.git
cd Kuanli
npm install
cp .env.local.example .env.local   # Supabase + Meta credentials
npm run dev
```

Apply the SQL in `supabase/migrations/` against your Supabase project in
filename order before first run.

## Dev-loop reference

| Command | What it does |
| --- | --- |
| `npm run dev` | Turbopack dev server on port 3000. |
| `npm run build` | Production build. Next also runs its own typecheck here. |
| `npm run typecheck` | `tsc --noEmit`. Fast TS-only pass. |
| `npm run lint` | ESLint. |
| `npm run test` | Vitest. |
| `npm run format` | Prettier write. |
| `npm run format:check` | Prettier in check-only mode. Useful in CI. |

## Reporting bugs

Open an issue with the commit SHA you're on, what you expected, what
happened, and logs if you have them. For anything involving the WhatsApp
webhook, include the message flow — which direction, which number, and
whether it came through a template or a free-form send.

## Reporting security issues

**Do not file security issues publicly.** Follow the private flow in
[`.github/SECURITY.md`](./.github/SECURITY.md).

## Pull requests

- Branch off the latest `main`.
- Run `npm run typecheck`, `npm run test`, and `npm run format` first.
- One logical change per PR, and fill in the **Test plan**.
- Commit-message first line is imperative and terse; the body explains
  the *why*, the diff shows the *what*.
- Open an issue first for anything non-trivial, to align before you build.

Extra scrutiny applies to changes touching the WhatsApp webhook, auth,
RLS policies, or migrations — those are the paths where a mistake reaches
real conversations or real data.

### Migrations

Migrations are numbered and applied in filename order, and every one is
expected to carry a header explaining its rationale and its rollback.
Match the existing style; the numbering is append-only, so take the next
free number rather than reusing one.

## Licensing

MIT ([`LICENSE`](./LICENSE)). Contributions are assumed to be MIT too.
The project forked from the MIT-licensed
[wacrm template](https://github.com/ArnasDon/wacrm), whose copyright
notice is retained in `LICENSE` as that license requires.
