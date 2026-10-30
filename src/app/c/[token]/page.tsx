// ============================================================
// /c/[token] - KB-CHATLINK-20261030. Read-only chat of ONE conversation.
//
// The token (chat_links, minted by n8n at handover, 7 days) is the only key:
// no session, so this page reads with the service role and must never show
// anything but the one conversation the token names. Unknown, malformed or
// expired tokens all get the same "link expired" page (no oracle).
// ============================================================

import { supabaseAdmin } from '@/lib/automations/admin-client';
import { isChatToken, toChatLine, type ChatLine } from '@/lib/chat-link/format';
import { AutoRefresh } from './auto-refresh';

export const dynamic = 'force-dynamic';

type Msg = { sender_type: string; content_type: string; content_text: string | null; created_at: string };

async function load(token: string) {
  if (!isChatToken(token)) return null;
  const db = supabaseAdmin();
  const { data: link } = await db
    .from('chat_links')
    .select('conversation_id, expires_at')
    .eq('token', token)
    .gt('expires_at', new Date().toISOString())
    .maybeSingle();
  if (!link) return null;
  const [{ data: conv }, { data: msgs }] = await Promise.all([
    db.from('conversations').select('id, contacts(name, phone)').eq('id', link.conversation_id).maybeSingle(),
    db.from('messages')
      .select('sender_type, content_type, content_text, created_at')
      .eq('conversation_id', link.conversation_id)
      .order('created_at', { ascending: true })
      .limit(400),
  ]);
  if (!conv) return null;
  const contact = (Array.isArray(conv.contacts) ? conv.contacts[0] : conv.contacts) as { name?: string; phone?: string } | null;
  return { name: contact?.name || 'Lead', phone: contact?.phone || '', expires: link.expires_at as string, msgs: (msgs ?? []) as Msg[] };
}

const time = (iso: string) =>
  new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true });

const LABEL: Record<ChatLine['who'], string> = { lead: 'Lead', bot: 'Bot', counsellor: 'Counsellor', other: 'System' };

export default async function ChatLinkPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const chat = await load(token);
  if (!chat) {
    return (
      <main className="mx-auto max-w-md px-4 py-16 text-center">
        <h1 className="text-lg font-semibold">This chat link has expired</h1>
        <p className="mt-2 text-sm text-slate-600">Links work for 7 days. Ask for a fresh one from the next lead alert.</p>
      </main>
    );
  }
  const phone = chat.phone.replace(/\D/g, '');
  return (
    <main className="mx-auto max-w-md pb-10">
      <AutoRefresh seconds={15} />
      <header className="sticky top-0 z-10 border-b border-slate-200 bg-white px-4 py-3">
        <div className="text-base font-semibold">{chat.name}</div>
        <div className="flex items-center justify-between text-sm text-slate-600">
          <span>+{phone}</span>
          <a className="font-medium text-emerald-700" href={`https://wa.me/${phone}`}>Open WhatsApp</a>
        </div>
        <div className="text-xs text-slate-400">Read-only. Updates every 15 s. Link valid till {time(chat.expires)}.</div>
      </header>
      <ol className="space-y-2 px-3 pt-3">
        {chat.msgs.map((m, i) => {
          const line = toChatLine(m.sender_type, m.content_type, m.content_text);
          const mine = line.who !== 'lead';
          return (
            <li key={i} className={`flex flex-col ${mine ? 'items-end' : 'items-start'}`}>
              {line.ad && <div className="mb-1 rounded-md bg-amber-50 px-2 py-1 text-xs text-amber-800">Ad clicked: {line.ad}</div>}
              {line.note && (
                <div className="max-w-[85%] rounded-xl border border-dashed border-slate-300 bg-slate-50 px-3 py-2 text-xs italic text-slate-600">
                  {line.text}
                </div>
              )}
              {line.text && !line.note && (
                <div className={`max-w-[85%] whitespace-pre-wrap break-words rounded-2xl px-3 py-2 text-sm shadow-sm ${mine ? 'bg-emerald-100' : 'bg-white'}`}>
                  {line.text}
                </div>
              )}
              <span className="mt-0.5 text-[11px] text-slate-400">{LABEL[line.who]} · {time(m.created_at)}</span>
            </li>
          );
        })}
      </ol>
      {chat.msgs.length === 0 && <p className="px-4 pt-6 text-sm text-slate-500">No messages yet.</p>}
    </main>
  );
}
