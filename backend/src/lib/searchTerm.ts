/**
 * Turning what somebody typed into a LIKE pattern.
 *
 * This exists because `%` and `_` are not ordinary characters to LIKE. A search
 * box that passes them through unescaped answers "%" with the entire database
 * and "a_b" with rows that do not contain "a_b" at all. Neither looks like a
 * bug from the outside — the first looks like a generous search, the second
 * like a missing row — which is exactly why it needs to be a named, tested
 * function rather than a string concatenation at the call site.
 *
 * Backslash is Postgres's default LIKE escape character, so it has to be
 * doubled BEFORE the wildcards are escaped with it — otherwise escaping "\"
 * would produce the escape sequence for whatever character followed it.
 */

/** Below this, every query matches half the restaurant, so nothing is returned. */
export const MIN_SEARCH_LENGTH = 2;

/** The longest term worth sending. Beyond it, nothing can match anyway. */
export const MAX_SEARCH_LENGTH = 120;

/** Escapes the three characters LIKE treats as syntax. Order matters. */
export function escapeLike(term: string): string {
  return term.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

/** `%term%` — matches the term anywhere in the value. */
export function likeContains(term: string): string {
  return `%${escapeLike(term)}%`;
}

/** `term%` — matches only at the start, which is how an id is recognised. */
export function likePrefix(term: string): string {
  return `${escapeLike(term)}%`;
}

/**
 * Normalises a raw `?q=` into the term the queries should use, or null when
 * there is nothing worth asking the database.
 *
 * A leading `#` is dropped because that is how order numbers are written down
 * and read back out ("#3f9c…"), but it is not part of the stored id.
 */
export function normalizeSearchTerm(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().slice(0, MAX_SEARCH_LENGTH);
  if (trimmed.length < MIN_SEARCH_LENGTH) return null;
  return trimmed;
}

/** The same term with a leading `#` removed, for matching against raw ids. */
export function withoutHash(term: string): string {
  return term.startsWith('#') ? term.slice(1) : term;
}
