/**
 * Keyset pagination cursor: the sort key of the last row a client has seen.
 * `at` is the row's timestamp (null only for a conversation that has no
 * message yet) and `id` breaks ties. The cursor is opaque, stateless and never
 * expires; the next page is "rows strictly after this position".
 */
export interface CursorPosition {
  at: Date | null;
  id: number;
}

const MAX_ID = 2147483647;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function encodeCursor(at: Date | null, id: number): string {
  return Buffer.from(`${at ? at.toISOString() : '-'}|${id}`).toString(
    'base64url',
  );
}

/** Returns null for anything that is not a cursor produced by encodeCursor. */
export function decodeCursor(cursor: unknown): CursorPosition | null {
  if (typeof cursor !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(cursor))
    return null;
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  const match = /^(-|[^|]+)\|(\d{1,10})$/.exec(decoded);
  if (!match) return null;
  const id = Number(match[2]);
  if (id > MAX_ID) return null;
  if (match[1] === '-') return { at: null, id };
  if (!ISO.test(match[1])) return null;
  const at = new Date(match[1]);
  // Rejects impossible calendar dates that Date would silently normalise.
  return at.toISOString() === match[1] ? { at, id } : null;
}
