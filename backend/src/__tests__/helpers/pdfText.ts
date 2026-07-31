import zlib from 'zlib';

/**
 * Pulls the text back out of a PDF, the way a reader's copy-paste would.
 *
 * There is no PDF renderer in this environment, so "does it look right" cannot
 * be answered by looking. This answers the next best thing, and arguably a
 * better one: the glyphs actually written to the page, mapped back through the
 * document's own ToUnicode tables to the characters they claim to be.
 *
 * It catches the two failures that matter and that nothing else here can:
 *
 *   - text drawn with a font that has no glyph for it. The Arabic and Latin
 *     subsets in use are DISJOINT, so one wrong `font()` call turns a whole
 *     column into blanks — which come back out of here as nothing.
 *   - Arabic left in logical order. A correctly shaped RTL run is stored
 *     VISUALLY, so "تقرير" comes back reversed. That is how this can tell that
 *     shaping and reordering really reached the page, rather than trusting that
 *     the font library did its job.
 *
 * Each font carries its OWN ToUnicode table, and glyph id 5 means different
 * things in different subsets — so runs are decoded with the table belonging to
 * the font that was selected when they were drawn, not with a merged one.
 */

interface Objects {
  /** Inflated stream body, by object number. */
  streams: Map<number, string>;
  /** Raw dictionary text, by object number. */
  dicts: Map<number, string>;
}

function parseObjects(pdf: Buffer): Objects {
  const text = pdf.toString('latin1');
  const streams = new Map<number, string>();
  const dicts = new Map<number, string>();

  for (const match of text.matchAll(/(\d+) 0 obj/g)) {
    const num = Number(match[1]);
    const start = match.index + match[0].length;
    const end = text.indexOf('endobj', start);
    if (end < 0) continue;

    const body = text.slice(start, end);
    dicts.set(num, body.slice(0, Math.min(body.length, 4000)));

    const streamAt = body.search(/stream\r?\n/);
    if (streamAt >= 0) {
      const from = streamAt + body.slice(streamAt).match(/stream\r?\n/)![0].length;
      const to = body.indexOf('endstream', from);
      if (to > from) {
        const raw = Buffer.from(body.slice(from, to), 'latin1');
        try {
          streams.set(num, zlib.inflateSync(raw).toString('latin1'));
        } catch {
          streams.set(num, raw.toString('latin1'));
        }
      }
    }
  }

  return { streams, dicts };
}

/** A ToUnicode destination is UTF-16BE and may be more than one character. */
function utf16(hex: string): string {
  let out = '';
  for (let i = 0; i + 4 <= hex.length; i += 4) {
    out += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
  }
  return out;
}

function parseCMap(stream: string): Map<number, string> {
  const map = new Map<number, string>();

  for (const block of stream.match(/beginbfchar([\s\S]*?)endbfchar/g) ?? []) {
    for (const [, src, dst] of block.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      map.set(parseInt(src, 16), utf16(dst));
    }
  }

  for (const block of stream.match(/beginbfrange([\s\S]*?)endbfrange/g) ?? []) {
    // The ARRAY form — one destination per code — is what PDFKit writes, and it
    // must be handled first: the scalar pattern would otherwise match the
    // range's two hex tokens plus the array's first element and map the entire
    // range onto one wrong character.
    for (const [, lo, , list] of block.matchAll(
      /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*\[([^\]]*)\]/g,
    )) {
      let code = parseInt(lo, 16);
      for (const [, dst] of list.matchAll(/<([0-9A-Fa-f]*)>/g)) {
        map.set(code, utf16(dst));
        code += 1;
      }
    }

    for (const [, lo, hi, dst] of block
      .replace(/\[[^\]]*\]/g, '')
      .matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      const start = parseInt(lo, 16);
      const end = parseInt(hi, 16);
      const base = parseInt(dst, 16);
      for (let i = 0; i <= end - start; i += 1) map.set(start + i, String.fromCodePoint(base + i));
    }
  }

  return map;
}

/** Resource name (`F2`) → that font's ToUnicode table. */
function fontTables({ streams, dicts }: Objects): Map<string, Map<number, string>> {
  const cmapByObject = new Map<number, Map<number, string>>();
  for (const [num, body] of streams) {
    if (body.includes('beginbfchar') || body.includes('beginbfrange')) {
      cmapByObject.set(num, parseCMap(body));
    }
  }

  // A font object points at its own ToUnicode; a page's resources point at the
  // font under the short name the content stream uses.
  const toUnicodeOf = new Map<number, number>();
  for (const [num, dict] of dicts) {
    const ref = dict.match(/\/ToUnicode\s+(\d+)\s+0\s+R/);
    if (ref) toUnicodeOf.set(num, Number(ref[1]));
  }

  const byName = new Map<string, Map<number, string>>();
  for (const dict of dicts.values()) {
    const fonts = dict.match(/\/Font\s*<<([\s\S]*?)>>/);
    if (!fonts) continue;
    for (const [, name, objNum] of fonts[1].matchAll(/\/(F\d+)\s+(\d+)\s+0\s+R/g)) {
      const cmapObj = toUnicodeOf.get(Number(objNum));
      const cmap = cmapObj !== undefined ? cmapByObject.get(cmapObj) : undefined;
      if (cmap) byName.set(name, cmap);
    }
  }

  return byName;
}

export interface TextRun {
  /** The resource name of the font it was drawn with — F2, F3, … */
  font: string;
  text: string;
}

/**
 * Every run of shown text, in drawing order, each with the font it used.
 *
 * Kept as separate runs rather than one string on purpose: the whole point of
 * this document format is that a run is never mixed-script, and joining them
 * would hide exactly the thing worth checking.
 */
export function pdfTextRuns(pdf: Buffer): TextRun[] {
  const objects = parseObjects(pdf);
  const tables = fontTables(objects);
  const runs: TextRun[] = [];

  for (const body of objects.streams.values()) {
    if (!body.includes('Tj') && !body.includes('TJ')) continue;

    let current = '';
    // One pass over the stream, in order, so `Tf` (select font) is seen before
    // the text it applies to.
    for (const token of body.matchAll(
      /\/(F\d+)\s+[\d.]+\s+Tf|((?:<[0-9A-Fa-f]*>|\[[^\]]*\]))\s*T[jJ]/g,
    )) {
      if (token[1]) {
        current = token[1];
        continue;
      }
      const cmap = tables.get(current);
      if (!cmap) continue;

      let text = '';
      for (const [, hex] of token[2].matchAll(/<([0-9A-Fa-f]*)>/g)) {
        for (let i = 0; i + 4 <= hex.length; i += 4) {
          text += cmap.get(parseInt(hex.slice(i, i + 4), 16)) ?? '';
        }
      }
      if (text.length > 0) runs.push({ font: current, text });
    }
  }

  return runs;
}

/** Everything the document says, for a simple "is it in there" check. */
export function pdfText(pdf: Buffer): string {
  return pdfTextRuns(pdf)
    .map((r) => r.text)
    .join('\n');
}

/** Arabic is stored visually, so a logical string is looked for reversed. */
export function visualOrder(logical: string): string {
  return [...logical].reverse().join('');
}

/**
 * How many Arabic characters a string is worth ONCE DRAWN.
 *
 * Lam followed by any alef shapes into a single lam-alef glyph, and that
 * glyph's ToUnicode entry names only one of the two letters — so reading the
 * page back always finds fewer characters than went in, by exactly the number
 * of those pairs. Correcting for it here keeps a "nothing was dropped" check
 * tight instead of forcing a loose tolerance that would also let a missing
 * column through.
 */
export function drawnArabicLength(text: string): number {
  const arabic = [...text].filter((c) => /\p{Script=Arabic}/u.test(c)).length;
  const ligatures = (text.match(/ل[اأإآ]/g) ?? []).length;
  return arabic - ligatures;
}
