import { afterEach, describe, expect, it, vi } from 'vitest';
import { isPhoneNumberAiDisabled } from './ai-disabled';

describe('isPhoneNumberAiDisabled', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('counsellor numbers in the list are silenced; the bot number is not', () => {
    const list = '1197620893430601, 2000000000000001,2000000000000002';
    expect(isPhoneNumberAiDisabled('2000000000000001', list)).toBe(true);
    expect(isPhoneNumberAiDisabled('2000000000000002', list)).toBe(true);
    expect(isPhoneNumberAiDisabled('1197620893430601', list)).toBe(true);
    expect(isPhoneNumberAiDisabled('1320822847785161', list)).toBe(false);
  });
  it('empty or unset disables nothing; no partial matches', () => {
    expect(isPhoneNumberAiDisabled('1320822847785161', '')).toBe(false);
    expect(isPhoneNumberAiDisabled('1320822847785161', undefined)).toBe(false);
    expect(isPhoneNumberAiDisabled('', ',,')).toBe(false);
    expect(isPhoneNumberAiDisabled('200000000000000', '2000000000000001')).toBe(
      false
    );
  });
  it('reads AI_DISABLED_PHONE_NUMBER_IDS by default', () => {
    vi.stubEnv('AI_DISABLED_PHONE_NUMBER_IDS', '2000000000000001');
    expect(isPhoneNumberAiDisabled('2000000000000001')).toBe(true);
    expect(isPhoneNumberAiDisabled('1320822847785161')).toBe(false);
  });
});
