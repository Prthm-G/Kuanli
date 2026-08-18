import type { ReactNode } from "react";

/**
 * Render WhatsApp's inline markup as React elements.
 *
 * WhatsApp supports `*bold*`, `_italic_`, `~strikethrough~` and
 * ```` ```monospace``` ````. The Kuanli inbox previously printed `content_text`
 * raw, so an outbound message stored as `*₹39,000*` — which is correct WhatsApp
 * syntax and renders bold on the handset — showed its asterisks literally in the
 * CRM. This closes that gap so the inbox matches what both sides actually see.
 *
 * Deliberately returns React nodes rather than an HTML string:
 * `content_text` carries attacker-controllable lead input, so building markup
 * and passing it to `dangerouslySetInnerHTML` would be an XSS hole. React
 * escapes every text node here.
 *
 * Matching follows WhatsApp's own rule that a delimiter pair must wrap
 * non-whitespace, so `2 * 3 * 4` and a lone `*` are left alone.
 */

type Rule = {
  re: RegExp;
  wrap: (children: ReactNode, key: string) => ReactNode;
};

const RULES: Rule[] = [
  // Monospace first: its content is literal and must not be re-parsed.
  {
    re: /```([\s\S]+?)```/,
    wrap: (c, k) => (
      <code key={k} className="rounded bg-black/10 px-1 font-mono text-[0.9em]">
        {c}
      </code>
    ),
  },
  { re: /\*([^\s*](?:[^*]*[^\s*])?)\*/, wrap: (c, k) => <strong key={k}>{c}</strong> },
  { re: /_([^\s_](?:[^_]*[^\s_])?)_/, wrap: (c, k) => <em key={k}>{c}</em> },
  { re: /~([^\s~](?:[^~]*[^\s~])?)~/, wrap: (c, k) => <del key={k}>{c}</del> },
];

function parse(text: string, ruleIdx: number): ReactNode {
  if (ruleIdx >= RULES.length) return text;

  const { re, wrap } = RULES[ruleIdx];
  const out: ReactNode[] = [];
  let rest = text;
  let key = 0;

  for (;;) {
    const m = rest.match(re);
    if (!m || m.index === undefined) {
      // No further matches for this rule: hand the remainder to the next one.
      out.push(parse(rest, ruleIdx + 1));
      break;
    }
    if (m.index > 0) out.push(parse(rest.slice(0, m.index), ruleIdx + 1));
    // Inner content goes to LATER rules only, which both allows sane nesting
    // (`*_bold italic_*`) and guarantees termination.
    out.push(wrap(parse(m[1], ruleIdx + 1), `w${ruleIdx}-${key++}`));
    rest = rest.slice(m.index + m[0].length);
  }

  return out;
}

/** Format `text` for display. Returns the input unchanged when it has no markup. */
export function formatWhatsAppText(text: string | null | undefined): ReactNode {
  if (!text) return text ?? null;
  return parse(text, 0);
}
