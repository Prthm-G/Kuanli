// Business numbers whose AI replies are switched off, as a comma-separated list
// of phone_number_ids in AI_DISABLED_PHONE_NUMBER_IDS. Read per call rather than
// cached at module load so the value is whatever the running process was started
// with, and an empty or unset variable disables nothing. SP3b lists the
// counsellors' own numbers here: Kuanli stores their chats, n8n never sees them.
export function isPhoneNumberAiDisabled(
  phoneNumberId: string,
  list: string | undefined = process.env.AI_DISABLED_PHONE_NUMBER_IDS
): boolean {
  return (list ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
    .includes(phoneNumberId);
}
