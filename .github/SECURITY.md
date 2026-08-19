# Security Policy

Thanks for taking the time to look into the security of this project.

## Reporting a vulnerability

**Do not open a public GitHub issue for security bugs.** Public issues are
indexed by search engines and visible to everyone long before a fix lands.

Instead, please report privately through
[GitHub Security Advisories](https://github.com/Prthm-G/Kuanli/security/advisories/new),
which keeps the disclosure and the fix in one place.

Include, if you can:

- A description of the issue and its impact.
- Reproduction steps or a proof-of-concept.
- The commit you're testing against.
- Whether you'd like credit in the eventual disclosure (credited by the name
  or handle you give, unless you prefer anonymous).

## What to expect

This is maintained by one person alongside other work, so response times are
best-effort rather than contractual:

- **Acknowledgement** within a few days.
- **Initial assessment** — severity, affected versions, whether a workaround
  exists — once the report is reproduced.
- **Fix and disclosure** on a timeline proportional to severity. Critical
  issues are patched as soon as a fix is ready.

## Scope

In scope — anything in this repository, including the WhatsApp webhook and
auth flows, token encryption, RLS policies, the storage buckets, and the
scheduled cron endpoints.

Out of scope:

- Vulnerabilities in Supabase, Next.js, Node.js, or other dependencies.
  Please report those to their maintainers; version bumps here on request.
- Issues that require an already-compromised deployment (for example a leaked
  service-role key) unless they widen the blast radius beyond that compromise.
- Social engineering, physical attacks, and third-party services added to a
  deployment after the fact.

## Upstream advisories

This project began as a fork of
[ArnasDon/wacrm](https://github.com/ArnasDon/wacrm). Advisories published
against the upstream template may also apply here, and vice versa. If you are
reporting something inherited from upstream, saying so helps — it should
probably be reported in both places.

## Safe harbor

Research conducted under this policy is authorized. No legal action will be
pursued against anyone who:

- Makes a good-faith effort to avoid data destruction, privacy violations,
  and service disruption.
- Allows reasonable time to respond before public disclosure.
- Does not exploit the issue beyond what is needed to demonstrate it.
