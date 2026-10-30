// ============================================================
// /c/[token] layout - KB-CHATLINK-20261030.
//
// Public, read-only view of ONE lead's 79019 chat for the counsellor who got
// the lead (link sent in their ntfy alert, valid 7 days). Sits outside
// (dashboard) and (auth) like /join: no login, no app chrome.
// no-referrer + noindex for the same reason as /join: the token is in the URL.
// ============================================================

import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'Lead chat',
  referrer: 'no-referrer',
  robots: { index: false, follow: false },
};

export default function ChatLinkLayout({ children }: { children: ReactNode }) {
  return <div className="min-h-screen bg-slate-100 text-slate-900">{children}</div>;
}
