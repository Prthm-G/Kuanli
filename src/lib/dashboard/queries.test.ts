import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { loadMetrics, loadResponseTime } from './queries'

// A stand-in for the browser client: every from() chain is recorded and resolves empty.
type Call = [string, ...unknown[]]
function fakeDb(counsellorNumbers: string[]) {
  const chains: { table: string; calls: Call[] }[] = []
  const db = {
    rpc: async () => ({ data: counsellorNumbers, error: null }),
    from(table: string) {
      const chain = { table, calls: [] as Call[] }
      chains.push(chain)
      const builder: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'not', 'gte', 'lt', 'order']) {
        builder[m] = (...args: unknown[]) => {
          chain.calls.push([m, ...args])
          return builder
        }
      }
      builder.then = (resolve: (v: unknown) => void) => resolve({ data: [], count: 0, error: null })
      return builder
    },
  }
  return { db: db as unknown as SupabaseClient, chains }
}

const messageChains = (chains: { table: string; calls: Call[] }[]) =>
  chains.filter((c) => c.table === 'messages')

describe('dashboard tiles count only messages sent from Kuanli', () => {
  it('Messages Sent Today leaves out chats on counsellor numbers', async () => {
    const { db, chains } = fakeDb(['100000000000002'])
    await loadMetrics(db)
    const msgs = messageChains(chains)
    expect(msgs).toHaveLength(2)
    for (const c of msgs) {
      expect(c.calls[0][1]).toContain('conversations!inner(phone_number_id)')
      expect(c.calls).toContainEqual(['not', 'conversations.phone_number_id', 'in', '("100000000000002")'])
    }
  })

  it('First response time leaves out chats on counsellor numbers', async () => {
    const { db, chains } = fakeDb(['100000000000002', '100000000000003'])
    await loadResponseTime(db)
    const [c] = messageChains(chains)
    expect(c.calls[0][1]).toContain('conversations!inner(phone_number_id)')
    expect(c.calls).toContainEqual([
      'not',
      'conversations.phone_number_id',
      'in',
      '("100000000000002","100000000000003")',
    ])
  })

  it('with no counsellor number linked the queries stay as they were', async () => {
    const { db, chains } = fakeDb([])
    await loadMetrics(db)
    await loadResponseTime(db)
    for (const c of messageChains(chains)) {
      expect(c.calls[0][1]).not.toContain('conversations!inner')
      expect(c.calls.some(([m]) => m === 'not')).toBe(false)
    }
  })
})
