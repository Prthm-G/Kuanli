/**
 * The Contacts page's message for a failed delete. Deleting a contact also
 * deletes their chats; since migration 094 a chat on a counsellor's own number
 * may only be deleted by an admin or the owner, and the database refuses the
 * whole delete with SQLSTATE P0094. Say so rather than a bare failure.
 */
export const COUNSELLOR_CHAT_DELETE_CODE = 'P0094';

export function contactDeleteError(
  error: { code?: string; message?: string },
  count: number
): string {
  if (error.code === COUNSELLOR_CHAT_DELETE_CODE) {
    return count > 1
      ? "Nothing was deleted: at least one of these contacts has chats on a counsellor's own number. Only an admin or the owner can delete those."
      : "This contact has chats on a counsellor's own number. Only an admin or the owner can delete it.";
  }
  return count > 1 ? 'Failed to delete contacts' : 'Failed to delete contact';
}
