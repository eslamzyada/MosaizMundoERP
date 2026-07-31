import {
  MAX_SEARCH_LENGTH,
  MIN_SEARCH_LENGTH,
  escapeLike,
  likeContains,
  likePrefix,
  normalizeSearchTerm,
  withoutHash,
} from '../lib/searchTerm';

/**
 * The pattern builder, without a database.
 *
 * The API suite proves the effect; this proves the one detail that suite
 * cannot reach — the ORDER of the three replacements. Escaping the wildcards
 * before the backslash turns `\` + `%` into an escape sequence for a per-cent
 * sign, so a search for a literal backslash silently becomes a wildcard again.
 * Nothing about that is visible from the outside.
 */

describe('escapeLike', () => {
  it('leaves ordinary text alone', () => {
    expect(escapeLike('طماطم')).toBe('طماطم');
    expect(escapeLike('Olive Oil')).toBe('Olive Oil');
  });

  it('neutralises the two wildcards', () => {
    expect(escapeLike('50%')).toBe('50\\%');
    expect(escapeLike('a_b')).toBe('a\\_b');
  });

  it('doubles a backslash BEFORE using it as the escape character', () => {
    // Wrong order: '\' -> '\' then '%' -> '\%' gives '\\%' read as
    // (escaped backslash)(wildcard) — the per-cent goes back to matching
    // anything at all.
    expect(escapeLike('\\%')).toBe('\\\\\\%');
  });

  it('handles a string that is nothing but syntax', () => {
    expect(escapeLike('%_%')).toBe('\\%\\_\\%');
  });
});

describe('the patterns', () => {
  it('wraps for a contains match', () => {
    expect(likeContains('kg')).toBe('%kg%');
    expect(likeContains('100%')).toBe('%100\\%%');
  });

  it('anchors a prefix match at the start only', () => {
    expect(likePrefix('aaaa')).toBe('aaaa%');
    expect(likePrefix('aaaa').startsWith('%')).toBe(false);
  });
});

describe('normalizeSearchTerm', () => {
  it('rejects anything too short to be a question', () => {
    expect(normalizeSearchTerm('')).toBeNull();
    expect(normalizeSearchTerm('a')).toBeNull();
    expect(normalizeSearchTerm('   b   ')).toBeNull();
    expect(MIN_SEARCH_LENGTH).toBe(2);
  });

  it('rejects anything that is not a string', () => {
    // Express gives an ARRAY for a repeated ?q=, and `undefined` for none.
    // Either one reaching a template literal would be a query for "undefined".
    expect(normalizeSearchTerm(undefined)).toBeNull();
    expect(normalizeSearchTerm(['a', 'b'])).toBeNull();
    expect(normalizeSearchTerm({ q: 'x' })).toBeNull();
  });

  it('trims, then measures', () => {
    expect(normalizeSearchTerm('  زعتر  ')).toBe('زعتر');
  });

  it('caps a term long enough to be an attack on the index', () => {
    const long = 'x'.repeat(MAX_SEARCH_LENGTH + 500);
    expect(normalizeSearchTerm(long)).toHaveLength(MAX_SEARCH_LENGTH);
  });
});

describe('withoutHash', () => {
  it('drops the hash an order number is written with', () => {
    expect(withoutHash('#aaaa1111')).toBe('aaaa1111');
  });

  it('drops only a LEADING one', () => {
    expect(withoutHash('a#b')).toBe('a#b');
    expect(withoutHash('##x')).toBe('#x');
  });
});
