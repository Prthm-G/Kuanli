/**
 * Keeps only the newest of several overlapping requests for the same thing.
 * Each request claims a number; a response is applied only if no request
 * claimed a later one meanwhile, so a slow poll cannot overwrite a fresher
 * answer (for "My leads": bring back a lead just marked Not interested).
 */
export function latestOnly() {
  let seq = 0;
  const claim = () => ++seq;
  const isLatest = (n: number) => n === seq;
  async function run<T>(
    fetch: () => Promise<T>,
    apply: (value: T) => void
  ): Promise<void> {
    const n = claim();
    const value = await fetch();
    if (isLatest(n)) apply(value);
  }
  return { claim, isLatest, run };
}
