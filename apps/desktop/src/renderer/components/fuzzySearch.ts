/**
 * Fuzzy search for the command palette v2 (v0.96, Team T6).
 *
 * Hand-written, zero-dependency subsequence matcher — no heavy
 * library for a palette. Scoring rewards what a user expects:
 * a match at the start of the text, at a word boundary, and
 * consecutive characters beat scattered ones. Matching is
 * diacritic-insensitive (Vietnamese "bot" finds "bốt", "trợ lý"
 * finds "tro ly") and case-insensitive.
 *
 * `fuzzyScore(query, text)` returns null when the query is not a
 * subsequence of the text, otherwise a score in (0, 1] — higher is
 * a better match. `fuzzyFilter` ranks a list best-first and keeps
 * the sort stable for equal scores.
 */

/** Strip diacritics + lowercase, so "đ" → "d", "ế" → "e". */
export function normalizeFuzzyText(value: string): string {
  return (value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase();
}

function isWordBoundary(text: string, index: number): boolean {
  if (index === 0) return true;
  const prev = text[index - 1];
  return prev === undefined || /[\s\-_/.:]/.test(prev);
}

/**
 * Score how well `query` fuzzy-matches `text`. The algorithm walks
 * the query left to right and, for each query character, takes the
 * earliest text position at or after the previous match that keeps
 * the rest of the query matchable (greedy forward scan with a
 * look-ahead: a position is only taken when the remaining query can
 * still match after it). Each matched character earns points for
 * being at a word start (+0.3), consecutive with the previous match
 * (+0.5), or at the very start of the text (+0.4); a gap costs
 * 0.05 per skipped character. The raw total is normalised by text
 * length so short exact matches outrank long loose ones.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const q = normalizeFuzzyText(query.trim());
  const t = normalizeFuzzyText(text);
  if (q.length === 0) return 1;
  if (t.length === 0) return null;
  if (q.length > t.length) return null;

  // Positions of each query character in the text (greedy, but with
  // a feasibility check: after taking position p for q[i], the rest
  // of q must still be a subsequence of t[p+1..]).
  const positions: number[] = [];
  let from = 0;
  for (let i = 0; i < q.length; i++) {
    const ch = q[i];
    if (ch === undefined) return null;
    let found = -1;
    for (let p = from; p < t.length; p++) {
      if (t[p] !== ch) continue;
      // Can the remaining query still match after p?
      let ok = true;
      let scan = p + 1;
      for (let j = i + 1; j < q.length; j++) {
        const next = t.indexOf(q[j] ?? '', scan);
        if (next === -1) {
          ok = false;
          break;
        }
        scan = next + 1;
      }
      if (ok) {
        found = p;
        break;
      }
    }
    if (found === -1) return null;
    positions.push(found);
    from = found + 1;
  }

  let score = 0;
  let prevPos = -2;
  for (let i = 0; i < positions.length; i++) {
    const pos = positions[i] as number;
    let charScore = 0.4;
    if (pos === 0) charScore += 0.4;
    else if (isWordBoundary(t, pos)) charScore += 0.3;
    if (prevPos === pos - 1) charScore += 0.5;
    else if (i > 0) charScore -= Math.min(0.5, (pos - prevPos - 1) * 0.05);
    score += charScore;
    prevPos = pos;
  }
  // Normalise: a perfect match of the whole text scores ~1.
  const maxPerChar = 1.1;
  const raw = score / (q.length * maxPerChar);
  // Prefer shorter texts when the match quality is equal.
  const lengthPenalty = t.length === q.length ? 0 : Math.min(0.25, (t.length - q.length) * 0.005);
  return Math.max(0.01, Math.min(1, raw - lengthPenalty));
}

/** Rank `items` by fuzzy match against `query` (best first). */
export function fuzzyFilter<T>(
  items: readonly T[],
  query: string,
  getText: (item: T) => string,
): Array<{ item: T; score: number }> {
  const q = query.trim();
  if (q.length === 0) return items.map((item) => ({ item, score: 1 }));
  const scored: Array<{ item: T; score: number; index: number }> = [];
  items.forEach((item, index) => {
    const score = fuzzyScore(q, getText(item));
    if (score !== null) scored.push({ item, score, index });
  });
  // Stable: equal scores keep the input order.
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.map(({ item, score }) => ({ item, score }));
}

/**
 * Highlight ranges for the matched characters, for the palette to
 * render in bold. Returns [start, end) ranges into the ORIGINAL
 * text (same length as the normalised one for the characters we
 * match — NFD decomposition can change length, so this maps back
 * through the normalised form conservatively: it only highlights
 * when the lengths line up, otherwise returns []).
 */
export function fuzzyMatchRanges(query: string, text: string): Array<[number, number]> {
  const q = normalizeFuzzyText(query.trim());
  const t = normalizeFuzzyText(text);
  if (q.length === 0 || t.length === 0) return [];
  if (t.length !== text.length) return [];
  const ranges: Array<[number, number]> = [];
  let from = 0;
  for (const ch of q) {
    const p = t.indexOf(ch, from);
    if (p === -1) return [];
    ranges.push([p, p + 1]);
    from = p + 1;
  }
  return ranges;
}
