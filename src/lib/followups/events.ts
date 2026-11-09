/**
 * Same-tab signal that follow-up entries changed: the log form fires it after
 * a save, and the sidebar badge and "My leads" listen, so neither waits for a
 * poll or a reload. Other people's changes arrive over realtime instead.
 */
const FOLLOW_UPS_CHANGED = 'kuanli:follow-ups-changed';

export function announceFollowUpsChanged(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(FOLLOW_UPS_CHANGED));
}

/** Returns the unsubscribe function, for an effect's cleanup. */
export function onFollowUpsChanged(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener(FOLLOW_UPS_CHANGED, listener);
  return () => window.removeEventListener(FOLLOW_UPS_CHANGED, listener);
}
