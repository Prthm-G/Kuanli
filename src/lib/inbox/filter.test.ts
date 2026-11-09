import { describe, expect, it } from 'vitest';
import type { Conversation } from '@/types';
import {
  defaultInboxFilter,
  filterConversations,
  ownerMap,
  ownersChanged,
} from './filter';

const conv = (id: string, over: Partial<Conversation> = {}) =>
  ({
    id,
    status: 'open',
    unread_count: 0,
    assigned_agent_id: undefined,
    ...over,
  }) as Conversation;

const LIST = [
  conv('a', { assigned_agent_id: 'me', unread_count: 2 }),
  conv('b', { assigned_agent_id: 'other', status: 'pending' }),
  conv('c', { status: 'closed', assigned_agent_id: 'me' }),
  conv('d'),
];
const ids = (l: Conversation[]) => l.map((c) => c.id);

describe('filterConversations', () => {
  it('all, unread and statuses as before', () => {
    expect(ids(filterConversations(LIST, 'all', 'me'))).toEqual([
      'a',
      'b',
      'c',
      'd',
    ]);
    expect(ids(filterConversations(LIST, 'unread', 'me'))).toEqual(['a']);
    expect(ids(filterConversations(LIST, 'open', 'me'))).toEqual(['a', 'd']);
    expect(ids(filterConversations(LIST, 'pending', 'me'))).toEqual(['b']);
    expect(ids(filterConversations(LIST, 'closed', 'me'))).toEqual(['c']);
  });
  it('mine comes from the RPC set (093): without it, nothing', () => {
    expect(ids(filterConversations(LIST, 'mine', 'me'))).toEqual([]);
    expect(ids(filterConversations(LIST, 'mine', 'other'))).toEqual([]);
  });
  it("mine with no profile yet shows nothing, not everyone's chats", () => {
    const assigned = new Set(['a', 'd']);
    expect(filterConversations(LIST, 'mine', null, assigned)).toEqual([]);
    expect(filterConversations(LIST, 'mine', undefined, assigned)).toEqual([]);
  });
  it('mine shows owned and unowned chats the RPC returns', () => {
    const assigned = new Set(['a', 'd']);
    expect(ids(filterConversations(LIST, 'mine', 'me', assigned))).toEqual([
      'a',
      'd',
    ]);
  });
  it('mine hides a chat I own that the RPC left out (Lost, Not Interested)', () => {
    const assigned = new Set(['d']);
    expect(ids(filterConversations(LIST, 'mine', 'me', assigned))).toEqual([
      'd',
    ]);
  });
  it('mine still hides a closed chat', () => {
    const assigned = new Set(['c']);
    expect(ids(filterConversations(LIST, 'mine', 'me', assigned))).toEqual([]);
  });
  it('mine hides a chat someone else owns since the list was fetched', () => {
    const assigned = new Set(['b']);
    expect(ids(filterConversations(LIST, 'mine', 'me', assigned))).toEqual([]);
  });
  it('assignments do not widen the other filters', () => {
    const assigned = new Set(['b']);
    expect(ids(filterConversations(LIST, 'unread', 'me', assigned))).toEqual([
      'a',
    ]);
  });
});

describe('defaultInboxFilter', () => {
  it('counsellors and viewers land on their own leads', () => {
    expect(defaultInboxFilter('agent')).toBe('mine');
    expect(defaultInboxFilter('viewer')).toBe('mine');
  });
  it('owners and admins land on the whole inbox', () => {
    expect(defaultInboxFilter('owner')).toBe('open');
    expect(defaultInboxFilter('admin')).toBe('open');
  });
  it('an unknown role never flashes every chat', () => {
    expect(defaultInboxFilter(null)).toBe('mine');
  });
});

describe('ownersChanged', () => {
  it('is false for the same chats and owners', () => {
    const prev = ownerMap(LIST);
    expect(ownersChanged(prev, [...LIST])).toBe(false);
  });
  it('is true when a chat arrives', () => {
    expect(ownersChanged(ownerMap(LIST), [...LIST, conv('e')])).toBe(true);
  });
  it('is true when an owner changes or is cleared', () => {
    const prev = ownerMap(LIST);
    const moved = LIST.map((c) =>
      c.id === 'd' ? { ...c, assigned_agent_id: 'me' } : c
    );
    expect(ownersChanged(prev, moved)).toBe(true);
    const cleared = LIST.map((c) =>
      c.id === 'a' ? { ...c, assigned_agent_id: undefined } : c
    );
    expect(ownersChanged(prev, cleared)).toBe(true);
  });
  it('ignores message and unread changes', () => {
    const prev = ownerMap(LIST);
    const bumped = LIST.map((c) => ({ ...c, unread_count: 9 }));
    expect(ownersChanged(prev, bumped)).toBe(false);
  });
});
