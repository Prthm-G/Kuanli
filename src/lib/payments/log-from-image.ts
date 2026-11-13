/**
 * The inbox "log payment" dialog is opened from one message and attaches that
 * message's image as the receipt. It must only ever show for the conversation
 * the message belongs to; otherwise switching chats leaves the dialog bound to
 * the new chat's contact with the old chat's image.
 */
export function paymentMessageForConversation<
  T extends { conversation_id: string },
>(message: T | null, activeConversationId: string | null | undefined): T | null {
  if (!message || !activeConversationId) return null;
  return message.conversation_id === activeConversationId ? message : null;
}
