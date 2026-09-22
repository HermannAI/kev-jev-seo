// Minimal port of jev/tools/shared/text.mjs — just the pieces jev_seo_link_suggest needs: sentence splitting,
// key-token extraction, span enumeration. Pure code; nothing here calls Jev. Keep in sync with text.mjs by hand;
// there is no build step that shares them (text.mjs is ESM for the eval tools, this is the TS server).
const STOP = new Set(
  "a an the and or for you your with that this from are was were will can have has had not but all any how what when why who which about into over than then them they their its our out more most also such use using used one two get make made like just very well own new way ways between each every both other some only these those must should would could may might there here been being does did doing done per via of in on to as at by is it be if so we us do up no".split(
    " ",
  ),
);
const GENERIC = new Set(["startup", "startups", "business", "businesses", "investor", "investors", "growth", "funding", "founder", "founders", "guide", "best", "practice", "practices", "tip", "tips", "success", "term", "long", "right", "key", "company", "companies"]);
const VAGUE = new Set(["process", "strategies", "strategy", "model", "models", "plan", "plans", "funding", "investment", "investments", "financing", "profitability", "growth", "potential", "approach", "options", "option", "important", "information", "example", "examples"]);
const stem = (x: string) => x.replace(/s$/, "");
const words = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const tok = (s: string) => words(s).filter((x) => x.length >= 3 && !STOP.has(x)).map(stem);

export const splitSentences = (text: string): string[] =>
  text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 30 && s.length < 400);

export type KeyTokens = Map<string, number>;
// forSpans: title only, no summary — keeps stage B anchors tied to what the target IS, not incidental summary words.
export const keyTokens = (title: string, summary: string | undefined, forSpans: boolean): KeyTokens => {
  const m: KeyTokens = new Map();
  for (const x of tok(title)) if (!m.has(x)) m.set(x, GENERIC.has(x) ? 0.3 : 1);
  if (!forSpans) for (const x of tok(summary || "").slice(0, 25)) if (!m.has(x)) m.set(x, 0.3);
  return m;
};
const overlap = (text: string, kt: KeyTokens): number => {
  const seen = new Set<string>();
  let w = 0;
  for (const x of tok(text)) if (kt.has(x) && !seen.has(x)) { seen.add(x); w += kt.get(x)!; }
  return w;
};
export const rankSentences = (sentences: string[], kt: KeyTokens, max: number): string[] =>
  sentences
    .map((x, i) => ({ x, i, w: overlap(x, kt) }))
    .filter((r) => r.w >= 1)
    .sort((a, b) => b.w - a.w)
    .slice(0, max)
    .sort((a, b) => a.i - b.i)
    .map((r) => r.x);

// Valid anchor-shaped spans inside a sentence (1 to 6 words). Code decides the shape; Jev decides which is best.
export function enumerateSpans(sentence: string, kt: KeyTokens, max: number): string[] {
  const ws = sentence.split(/\s+/);
  const all = new Map<string, number>();
  const relevant = new Map<string, number>();
  const clean = (w: string) => w.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "");
  for (let i = 0; i < ws.length; i++)
    for (let len = 1; len <= 6 && i + len <= ws.length; len++) {
      const seg = ws.slice(i, i + len);
      const first = clean(seg[0]).toLowerCase(), last = clean(seg[len - 1]).toLowerCase();
      if (!first || !last || STOP.has(first) || STOP.has(last)) continue;
      const phrase = seg.join(" ").replace(/^[^A-Za-z0-9]+/, "").replace(/[^A-Za-z0-9)]+$/, "");
      if (!phrase || phrase.length > 70 || /[.;:!?,]/.test(phrase.slice(0, -1)) || phrase.includes("[[")) continue;
      if (((phrase.match(/[“”"]/g) || []).length) % 2 === 1) continue; // unbalanced quote: the span cuts through a quoted title
      const inner = seg.slice(1, -1).filter((w) => STOP.has(clean(w).toLowerCase())).length;
      if ((len <= 4 && inner > 1) || (len > 4 && inner > 2)) continue;
      if (len === 1 && (GENERIC.has(stem(first)) || VAGUE.has(first) || first.length < 8)) continue;
      if (len === 2 && VAGUE.has(first) && VAGUE.has(last)) continue;
      if (!sentence.includes(phrase)) continue;
      const ov = overlap(phrase, kt);
      all.set(phrase, -Math.abs(len - 3) * 0.1);
      if (ov >= 1) relevant.set(phrase, ov - 0.05 * len);
    }
  const pool = relevant.size ? relevant : all;
  return [...pool.entries()].sort((a, b) => b[1] - a[1]).slice(0, max).map(([p]) => p);
}
