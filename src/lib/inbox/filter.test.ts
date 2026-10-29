import { describe, expect, it } from 'vitest';
import type { Conversation } from '@/types';
import { filterConversations } from './filter';

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
  it('mine: assigned to the signed-in profile, closed ones archived', () => {
    expect(ids(filterConversations(LIST, 'mine', 'me'))).toEqual(['a']);
    expect(ids(filterConversations(LIST, 'mine', 'other'))).toEqual(['b']);
  });
  it("mine with no profile yet shows nothing, not everyone's chats", () => {
    expect(filterConversations(LIST, 'mine', null)).toEqual([]);
    expect(filterConversations(LIST, 'mine', undefined)).toEqual([]);
  });
});
