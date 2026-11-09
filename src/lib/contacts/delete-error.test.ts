import { describe, expect, it } from 'vitest';
import { contactDeleteError } from './delete-error';

describe('contactDeleteError', () => {
  it('names the counsellor-number guard (migration 094, P0094) instead of a bare failure', () => {
    expect(contactDeleteError({ code: 'P0094', message: 'x' }, 1)).toBe(
      "This contact has chats on a counsellor's own number. Only an admin or the owner can delete it."
    );
    expect(contactDeleteError({ code: 'P0094' }, 3)).toBe(
      "Nothing was deleted: at least one of these contacts has chats on a counsellor's own number. Only an admin or the owner can delete those."
    );
  });
  it('any other error keeps the old text', () => {
    expect(contactDeleteError({ code: '42501' }, 1)).toBe(
      'Failed to delete contact'
    );
    expect(contactDeleteError({ message: 'x' }, 2)).toBe(
      'Failed to delete contacts'
    );
  });
});
