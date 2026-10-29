/**
 * wa.me link for a contact's phone (SP3b "Open in WhatsApp"): counsellors reply
 * from their own WhatsApp Business app, so the inbox hands them the chat there.
 * Digits only; null when the stored phone is too short to be a WhatsApp number.
 */
export function whatsappChatUrl(
  phone: string | null | undefined
): string | null {
  const digits = (phone ?? '').replace(/\D/g, '');
  return digits.length >= 8 && digits.length <= 15
    ? `https://wa.me/${digits}`
    : null;
}
