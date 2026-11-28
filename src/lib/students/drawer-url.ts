const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Same page, with ?student=<id> set (or removed when contactId is null). Other params are kept. */
export function studentHref(pathname: string, search: string, contactId: string | null): string {
  const params = new URLSearchParams(search);
  if (contactId) params.set('student', contactId);
  else params.delete('student');
  const q = params.toString();
  return q ? `${pathname}?${q}` : pathname;
}

export function readStudentParam(value: string | null): string | null {
  return value && UUID.test(value) ? value.toLowerCase() : null;
}
