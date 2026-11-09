import { describe, expect, it, vi } from 'vitest';
import {
  inboundActions,
  loadNumberPolicy,
  NUMBER_POLICY_MARKER,
  type NumberPolicy,
} from './number-policy';

// A stand-in for the service-role client: from('counsellor_number_history').select().eq().limit().
function fakeDb(result: { data: unknown; error: unknown } | Error) {
  const calls: { table?: string; column?: string; value?: string } = {};
  const db = {
    from(table: string) {
      calls.table = table;
      return {
        select: () => ({
          eq: (column: string, value: string) => {
            calls.column = column;
            calls.value = value;
            return {
              limit: async () => {
                if (result instanceof Error) throw result;
                return result;
              },
            };
          },
        }),
      };
    },
  };
  return { db, calls };
}

const BOT = '100000000000001';
const COUNSELLOR = '100000000000002';
const OLD = '100000000000003';

describe('loadNumberPolicy', () => {
  it('a number ever linked in counsellors.phone_number_id is a counsellor number (DB, no env needed)', async () => {
    const { db, calls } = fakeDb({
      data: [{ phone_number_id: COUNSELLOR }],
      error: null,
    });
    await expect(loadNumberPolicy(db, COUNSELLOR, '')).resolves.toEqual({
      counsellorNumber: true,
      aiDisabled: true,
    });
    expect(calls).toEqual({
      table: 'counsellor_number_history',
      column: 'phone_number_id',
      value: COUNSELLOR,
    });
  });

  it('the bot number is neither', async () => {
    const { db } = fakeDb({ data: [], error: null });
    await expect(loadNumberPolicy(db, BOT, '')).resolves.toEqual({
      counsellorNumber: false,
      aiDisabled: false,
    });
  });

  it('the env list still silences a number that is not a counsellor number', async () => {
    const { db } = fakeDb({ data: [], error: null });
    await expect(loadNumberPolicy(db, OLD, `${OLD}, 1`)).resolves.toEqual({
      counsellorNumber: false,
      aiDisabled: true,
    });
  });

  it('fails closed: a lookup error throws, so nothing is forwarded and the inbox row is replayed', async () => {
    const { db } = fakeDb({ data: null, error: { message: 'timeout' } });
    await expect(loadNumberPolicy(db, BOT, '')).rejects.toThrow(
      NUMBER_POLICY_MARKER
    );
  });

  it('fails closed when the lookup returns no rows array and no error', async () => {
    const { db } = fakeDb({ data: null, error: null });
    await expect(loadNumberPolicy(db, BOT, '')).rejects.toThrow(
      NUMBER_POLICY_MARKER
    );
  });

  it('fails closed on a thrown client error too', async () => {
    const { db } = fakeDb(new Error('fetch failed'));
    await expect(loadNumberPolicy(db, BOT, '')).rejects.toThrow(/fetch failed/);
  });

  it('reads AI_DISABLED_PHONE_NUMBER_IDS by default', async () => {
    vi.stubEnv('AI_DISABLED_PHONE_NUMBER_IDS', OLD);
    const { db } = fakeDb({ data: [], error: null });
    await expect(loadNumberPolicy(db, OLD)).resolves.toMatchObject({
      aiDisabled: true,
    });
    vi.unstubAllEnvs();
  });
});

describe('inboundActions', () => {
  const bot: NumberPolicy = { counsellorNumber: false, aiDisabled: false };
  const counsellor: NumberPolicy = { counsellorNumber: true, aiDisabled: true };
  const envOnly: NumberPolicy = { counsellorNumber: false, aiDisabled: true };

  it('bot number: forward, automations, mirror; no arrival', () => {
    expect(
      inboundActions(bot, { botActive: true, mirrorSetting: true })
    ).toEqual({
      forwardToBot: true,
      runAutomations: true,
      markArrival: false,
      mirrorMedia: true,
    });
  });

  it('bot paused on the chat: no forward, the rest as before', () => {
    expect(
      inboundActions(bot, { botActive: false, mirrorSetting: true })
    ).toMatchObject({ forwardToBot: false, runAutomations: true });
  });

  it('counsellor number: never the bot, no flows or automations, no public media copy, arrival marked', () => {
    expect(
      inboundActions(counsellor, { botActive: true, mirrorSetting: true })
    ).toEqual({
      forwardToBot: false,
      runAutomations: false,
      markArrival: true,
      mirrorMedia: false,
    });
  });

  it('env-listed number: no bot, as before; flows, automations and media as before', () => {
    expect(
      inboundActions(envOnly, { botActive: true, mirrorSetting: false })
    ).toEqual({
      forwardToBot: false,
      runAutomations: true,
      markArrival: true,
      mirrorMedia: false,
    });
  });
});
