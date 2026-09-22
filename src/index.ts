import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { systemOne, JevError, PINNED_MODEL, type Question } from "./client.js";
import {
  FORMAT_WORDS,
  META_LENGTH,
  THRESHOLDS,
  TITLE_LENGTH,
  anchorShapeQuestion,
  anchorSpecificQuestion,
  anchorTopicQuestion,
  headingQuestion,
  linkQuestion,
  metaQuestions,
  titleQuestions,
  THRESHOLDS4,
  WORDS,
  cannibalQuestion,
  depthQuestions,
  intentQuestions,
  schemaQuestions,
  sentenceQuestion,
  spanQuestion,
  THRESHOLDS5,
  voiceQuestions,
  comparisonFairnessQuestions,
  headingDeliversQuestion,
  faqAnswersQuestion,
  distinctivenessQuestions,
  THRESHOLDS6,
  citationTypeQuestion,
  citationSupportsQuestion,
  citationIdentityQuestion,
  THRESHOLDS7,
  vagueLinkQuestion,
} from "./questions.js";
import { enumerateSpans, keyTokens, rankSentences, splitSentences } from "./anchor-text.js";

const server = new McpServer({ name: "kev-jev", version: "0.7.0" });

const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
const fail = (e: unknown) => ({
  isError: true,
  content: [{ type: "text" as const, text: e instanceof JevError ? e.message : `Error: ${String(e)}` }],
});

type Answers = Record<string, { score?: number; noul?: number; choice?: string; confidence?: number; probabilities?: Record<string, number> }>;
type Res = { model?: string; answers: Answers };

const r2 = (x: number) => Math.round(x * 100) / 100;
const noul = (a: Answers, k: string) => a[k]?.noul ?? 0;

// Content-format words the text names but the page never mentions. Advisory only (see questions.ts).
const missingFormatWords = (text: string, content: string) => {
  const t = text.toLowerCase(), c = content.toLowerCase();
  return FORMAT_WORDS.filter((w) => t.includes(w) && !c.includes(w));
};

const questionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("choice"), instructions: z.any(), criteria: z.record(z.string(), z.any()).nullable() }),
  z.object({ type: z.literal("score"), instructions: z.any(), criteria: z.array(z.any()).min(2).max(10) }),
  z.object({
    type: z.literal("noul"),
    instructions: z.any(),
    criteria: z.object({ true: z.any().optional(), false: z.any().optional() }).optional(),
  }),
]);

server.registerTool(
  "jev_evaluate",
  {
    description:
      "Generic Jev call. Give it a state (text or JSON) and a map of typed questions (choice, score, noul). Returns calibrated answers. Jev judges; it does not write text, count or do maths.",
    inputSchema: {
      state: z.any().describe("Text or JSON evidence the questions are about"),
      questions: z.record(z.string(), questionSchema).describe("Map of question id to question"),
    },
  },
  async ({ state, questions }) => {
    try {
      return ok(await systemOne({ state, questions: questions as Record<string, Question> }));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "jev_seo_meta_check",
  {
    description:
      "Audit one page's meta description. Length is checked in code; Jev scores accuracy, intent match, benefit, stuffing, page intent, and whether the description promises anything the page does not contain. Send the FULL page text a visitor reads (rendered, not an excerpt). Verdict is rewrite if the length is off, an unsupported claim is 0.5 or more, it is stuffed, the accuracy/intent composite is below 0.66, or accuracy is below 2.2 of 3; review if the only problem is accuracy between 2.2 and 2.8 (terse or intro-paragraph descriptions; a person decides). On public editorial sites about 20% of real descriptions came back rewrite and 10% review, so expect to read the flags: it is a triage tool, not a verdict. Detection of injected false claims: 100% blatant, 86% to 100% subtle, 90% to 100% fresh, depending on the site.",
    inputSchema: {
      title: z.string(),
      content: z.string().describe("The full visible text of the page, plain (no HTML). Do not send an excerpt: missed false claims rose sharply on excerpts."),
      meta_description: z.string().describe("Current description, or empty string if none"),
      focus_keyword: z.string().optional(),
    },
  },
  async ({ title, content, meta_description, focus_keyword }) => {
    try {
      const chars = meta_description.trim().length;
      if (chars === 0) return ok({ length: { chars: 0, status: "missing" }, verdict: "rewrite", reasons: ["no description"] });
      const status = chars < META_LENGTH.min ? "short" : chars > META_LENGTH.max ? "long" : "ok";

      const res = (await systemOne({
        state: { page: { title, content }, meta_description, focus_keyword: focus_keyword ?? null },
        questions: metaQuestions(),
      })) as Res;

      const a = res.answers;
      const accuracy = a.accuracy?.score ?? 0;
      const composite = ((accuracy + (a.intent_match?.score ?? 0)) / 3) / 2;
      const unsupported = noul(a, "unsupported_claim"), stuffed = noul(a, "is_keyword_stuffed");
      const reasons: string[] = [];
      if (status !== "ok") reasons.push(`length ${chars} is ${status} (target ${META_LENGTH.min} to ${META_LENGTH.max})`);
      if (composite < THRESHOLDS.metaAcceptScore) reasons.push(`accuracy and intent composite ${r2(composite)} below ${THRESHOLDS.metaAcceptScore}`);
      if (accuracy < THRESHOLDS.accuracyFloor) reasons.push(`accuracy ${r2(accuracy)} below ${THRESHOLDS.accuracyFloor}`);
      if (unsupported >= THRESHOLDS.claimReject) reasons.push(`promises something the page does not contain (${r2(unsupported)})`);
      if (stuffed >= THRESHOLDS.stuffedReject) reasons.push(`keyword stuffed (${r2(stuffed)})`);
      const formatWords = missingFormatWords(meta_description, content);
      // Two tiers: a description whose ONLY problem is accuracy between the hard and soft floors is borderline (terse or intro-paragraph
      // descriptions on editorial sites), so it is a "review", not a "rewrite". Nothing that was flagged before stops being flagged.
      const borderlineOnly = reasons.length === 1 && accuracy < THRESHOLDS.accuracyFloor && accuracy >= THRESHOLDS.accuracyHard && status === "ok";
      return ok({
        model: res.model ?? PINNED_MODEL,
        length: { chars, status, target: META_LENGTH },
        composite: r2(composite),
        verdict: !reasons.length ? "keep" : borderlineOnly ? "review" : "rewrite",
        reasons,
        advisory: formatWords.length ? { format_words_not_on_page: formatWords, note: "Advisory only. Check by eye: the claim may be true but unstated on the page." } : undefined,
        answers: a,
      });
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "jev_seo_title_check",
  {
    description:
      "Audit one page's title tag. Length is checked in code (60 characters including any brand suffix); Jev scores accuracy, intent match, over-promising and stuffing. Send the FULL page text: subtle over-promise wording (implying a video, case study, interview etc. that is not on the page) is caught 79% of the time on unseen public sites, up from 49% before a rubric refinement on 2026-09-22 that names the content types explicitly and covers clauses appended after a site-name suffix; false flags on real titles fell alongside it (0.8% on public sites, 0% to 3% on the original test sites). Verdict is rewrite if accuracy is below 2.8 of 3, over-promise is 0.5 or more, or it is stuffed.",
    inputSchema: {
      title: z.string().describe("The title tag exactly as it will appear, including any brand suffix"),
      content: z.string().describe("The full visible text of the page, plain (no HTML)"),
      focus_keyword: z.string().optional(),
      h1: z.string().optional().describe("The visible headline, if it differs from the title"),
    },
  },
  async ({ title, content, focus_keyword, h1 }) => {
    try {
      const chars = title.trim().length;
      if (chars === 0) return ok({ length: { chars: 0, status: "missing" }, verdict: "rewrite", reasons: ["no title"] });
      const status = chars < TITLE_LENGTH.min ? "short" : chars > TITLE_LENGTH.max ? "long" : "ok";
      const res = (await systemOne({
        state: { title, h1: h1 ?? null, focus_keyword: focus_keyword ?? null, page: { content } },
        questions: titleQuestions(),
      })) as Res;
      const a = res.answers;
      const accuracy = a.accuracy?.score ?? 0, over = noul(a, "overpromises"), stuffed = noul(a, "keyword_stuffed");
      const reasons: string[] = [];
      if (status === "long") reasons.push(`length ${chars} is over ${TITLE_LENGTH.max}, so search results will cut it off`);
      if (accuracy < THRESHOLDS.accuracyFloor) reasons.push(`accuracy ${r2(accuracy)} below ${THRESHOLDS.accuracyFloor}`);
      if (over >= THRESHOLDS.claimReject) reasons.push(`promises something the page does not deliver (${r2(over)})`);
      if (stuffed >= THRESHOLDS.stuffedReject) reasons.push(`keyword stuffed (${r2(stuffed)})`);
      const formatWords = missingFormatWords(title, content);
      return ok({
        model: res.model ?? PINNED_MODEL,
        length: { chars, status, target: TITLE_LENGTH },
        verdict: reasons.length ? "rewrite" : "keep",
        reasons,
        advisory: formatWords.length ? { format_words_not_on_page: formatWords } : undefined,
        answers: a,
      });
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "jev_seo_link_pick",
  {
    description:
      "Judge internal-link candidates for one anchor in one source page. Put the anchor words in [[double brackets]] inside anchor_context. Every candidate is scored on three questions (link: useful and natural; specific: the words point to that page and not to many; topic: the words alone name that page's topic); score is their mean, and the anchor gets one shape check. Buckets: keep (score 0.60+, shape 0.60+, specific 0.30+), review (0.45+, shape 0.50+), else drop. Include one or two similar pages as decoys: if a similar page outscores your intended target, the anchor belongs to that page. Candidates must be pre-filtered by code (max 15).",
    inputSchema: {
      source: z.object({ title: z.string(), excerpt: z.string() }),
      anchor_context: z.string().describe("The sentence where the link would sit, with the anchor words wrapped in [[double brackets]]"),
      candidates: z.array(z.object({ id: z.string(), title: z.string(), summary: z.string() })).min(1).max(15),
    },
  },
  async ({ source, anchor_context, candidates }) => {
    try {
      if (!/\[\[[^\]]+\]\]/.test(anchor_context)) return fail(new JevError("anchor_context must wrap the anchor words in [[double brackets]], for example: 'Read our guide to [[tail coverage]] before you retire.'"));
      const questions: Record<string, Question> = { shape: anchorShapeQuestion };
      candidates.forEach((_, i) => {
        questions[`link${i}`] = linkQuestion(`candidates[${i}]`);
        questions[`spec${i}`] = anchorSpecificQuestion(`candidates[${i}]`);
        questions[`topic${i}`] = anchorTopicQuestion(`candidates[${i}]`);
      });
      const state = { source, anchor_context, candidates: candidates.map((c) => ({ title: c.title, summary: c.summary })) };
      const res = (await systemOne({ state, questions })) as Res;
      const shape = noul(res.answers, "shape");
      const results = candidates
        .map((c, i) => {
          const link = noul(res.answers, `link${i}`), spec = noul(res.answers, `spec${i}`), topic = noul(res.answers, `topic${i}`);
          const score = (link + spec + topic) / 3;
          const bucket =
            score >= THRESHOLDS.linkKeep && shape >= THRESHOLDS.linkKeepShape && spec >= THRESHOLDS.linkKeepSpecific
              ? "keep"
              : score >= THRESHOLDS.linkReview && shape >= THRESHOLDS.linkReviewShape
                ? "review"
                : "drop";
          return { id: c.id, title: c.title, score: r2(score), probability: r2(score), link: r2(link), specific: r2(spec), topic: r2(topic), bucket };
        })
        .sort((x, y) => y.score - x.score);
      return ok({ model: res.model ?? PINNED_MODEL, anchor_shape: r2(shape), results });
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "jev_seo_link_suggest",
  {
    description:
      "Given a source page's full text and one target page, find where to add an internal link: the best sentence, then the best anchor phrase inside it, then score it the way jev_seo_link_pick does. Measured on 171 real editor-placed links across 8 public sites (REPORT.md rounds 6 to 8): finds a valid location for 71% to 87% of real links depending on the site, and accepted an unrelated target for under 2% of pairs (most of those on inspection were defensible, not wrong). Pass up to 4 decoy pages (other candidates from the site) for the specificity check, the same as jev_seo_link_pick; omit decoys to score the target alone. `no_suggestion` is a normal, common answer, not an error: it means no sentence or no anchor phrase in this page clearly earns a link to this target yet.",
    inputSchema: {
      source: z.object({ title: z.string(), content: z.string().describe("Full visible text of the source page, plain") }),
      target: z.object({ title: z.string(), summary: z.string() }),
      decoys: z.array(z.object({ id: z.string(), title: z.string(), summary: z.string() })).max(4).optional().describe("Other candidate pages on the site, for the specificity/topic check. Omit if there are none to hand."),
    },
  },
  async ({ source, target, decoys }) => {
    try {
      const ktFull = keyTokens(target.title, target.summary, false);
      const ranked = rankSentences(splitSentences(source.content), ktFull, 25);
      if (!ranked.length) return ok({ stage: "no_suggestion", reason: "no sentence in the source mentions the target's topic" });
      const sopts: Record<string, string> = {}; ranked.forEach((s, i) => (sopts["S" + (i + 1)] = s));

      const a = (await systemOne({ state: { task: "Find the most natural sentence in the SOURCE page at which to add a link to the TARGET page.", source_page: source.title, target_page: target }, questions: sentenceQuestion(sopts) })) as Res;
      const A = a.answers.best_sentence, pick = A.choice;
      const pA = (pick ? A.probabilities?.[pick] : undefined) ?? A.confidence ?? 0;
      const pNone = A.probabilities?.none ?? 0;
      if (!pick || pick === "none" || !sopts[pick]) return ok({ stage: "no_suggestion", reason: "no sentence is a natural fit", p_none: r2(pNone) });
      if (pNone >= THRESHOLDS.linkMaxNone) return ok({ stage: "no_suggestion", reason: "best sentence not confident enough", p_none: r2(pNone) });
      if (pA < THRESHOLDS.linkMinSentence) return ok({ stage: "no_suggestion", reason: "low confidence in the chosen sentence", p_sentence: r2(pA) });
      const sentence = sopts[pick];

      const ktSpan = keyTokens(target.title, target.summary, true);
      const spans = enumerateSpans(sentence, ktSpan, 30);
      if (!spans.length) return ok({ stage: "no_suggestion", reason: "no anchor-shaped phrase in that sentence names the target", sentence });
      const popts: Record<string, string> = {}; spans.forEach((s, i) => (popts["P" + (i + 1)] = s));
      const b = (await systemOne({ state: { task: "Within one sentence, choose the words that should carry a link to the TARGET page.", sentence, target_page: target }, questions: spanQuestion(popts) })) as Res;
      const B = b.answers.best_span, ppick = B.choice;
      const pB = (ppick ? B.probabilities?.[ppick] : undefined) ?? B.confidence ?? 0;
      if (!ppick || !popts[ppick] || pB < THRESHOLDS.linkMinSpan) return ok({ stage: "no_suggestion", reason: "no anchor phrase was confident enough", sentence, p_span: r2(pB) });
      const phrase = popts[ppick];

      const cands = [{ id: "target", title: target.title, summary: target.summary }, ...(decoys ?? [])];
      const questions: Record<string, Question> = { shape: anchorShapeQuestion };
      cands.forEach((_, i) => { questions[`link${i}`] = linkQuestion(`candidates[${i}]`); questions[`spec${i}`] = anchorSpecificQuestion(`candidates[${i}]`); questions[`topic${i}`] = anchorTopicQuestion(`candidates[${i}]`); });
      const c = (await systemOne({ state: { source: { title: source.title, excerpt: source.content.slice(0, 300) }, anchor_context: sentence.replace(phrase, `[[${phrase}]]`), candidates: cands.map((x) => ({ title: x.title, summary: x.summary })) }, questions })) as Res;
      const shape = noul(c.answers, "shape");
      const scored = cands.map((x, i) => {
        const link = noul(c.answers, `link${i}`), spec = noul(c.answers, `spec${i}`), topic = noul(c.answers, `topic${i}`), score = (link + spec + topic) / 3;
        const bucket = score >= THRESHOLDS.linkKeep && shape >= THRESHOLDS.linkKeepShape && spec >= THRESHOLDS.linkKeepSpecific ? "keep" : score >= THRESHOLDS.linkReview && shape >= THRESHOLDS.linkReviewShape ? "review" : "drop";
        return { id: x.id, title: x.title, score: r2(score), link: r2(link), specific: r2(spec), topic: r2(topic), bucket };
      });
      const targetResult = scored[0], decoyResults = scored.slice(1).sort((m, n) => n.score - m.score);
      const retarget = decoyResults[0] && decoyResults[0].score > targetResult.score + 0.05 ? decoyResults[0] : null;
      return ok({
        model: c.model ?? PINNED_MODEL,
        stage: "found",
        sentence,
        anchor: phrase,
        anchor_shape: r2(shape),
        target: { score: targetResult.score, link: targetResult.link, specific: targetResult.specific, topic: targetResult.topic, bucket: targetResult.bucket },
        decoys: decoyResults,
        note: retarget ? `A decoy ("${retarget.title}") scored higher than the target by more than 0.05 (${retarget.score} vs ${targetResult.score}). Consider whether this anchor belongs to that page instead.` : undefined,
      });
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "jev_seo_heading_check",
  {
    description:
      "Flag generic or vague headings (Conclusion, Introduction, Final Thoughts, Take The Next Step, 'Unlocking the Potential of...'). One yes/no per heading in a single call. Measured AUC 0.99 against generic labels and 0.96 against vague marketing filler. Headings that are a generic label followed by a specific subtitle ('Conclusion: Choosing the Right Policy') are mostly let through, by design. Max 40 headings per call.",
    inputSchema: {
      headings: z.array(z.string()).min(1).max(40),
    },
  },
  async ({ headings }) => {
    try {
      const questions: Record<string, Question> = {};
      headings.forEach((_, i) => (questions[`h${i}`] = headingQuestion(`headings[${i}]`)));
      const res = (await systemOne({ state: { headings }, questions })) as Res;
      const results = headings.map((h, i) => {
        const p = noul(res.answers, `h${i}`);
        return { heading: h, generic: r2(p), flagged: p >= THRESHOLDS.headingGeneric };
      });
      return ok({ model: res.model ?? PINNED_MODEL, flagged: results.filter((r) => r.flagged).length, results });
    } catch (e) {
      return fail(e);
    }
  },
);

const clip = (text: string, n: number) => text.split(/\s+/).filter(Boolean).slice(0, n).join(" ");
const wordCount = (text: string) => text.split(/\s+/).filter(Boolean).length;
// Round 9 (REPORT.md): DataForSEO's classifier independently confirmed Jev's own miss (calling a service/sales page
// "informational"), always in this direction. Cheap, code-level second check rather than retuning the rubric.
const COMMERCIAL_SIGNAL = /(\$|€|£|\bUSD\b|\bZAR\b)\s?\d|\bpric(e|ing)\b|get (a )?quote|request a (demo|quote)|book a (call|demo)|contact (us|sales)|free trial|sign up|add to cart|buy now|start (your|a) free|schedule a (call|demo)/i;

// Page kinds that are thin by design. Inferred in code from the URL path (and title, for tools) when the caller does not say.
const EXEMPT_KINDS = new Set(["tool", "author", "collection", "listing", "video"]);
const inferPageKind = (url: string, title: string): string | undefined => {
  const path = url.replace(/^https?:\/\/[^/]+/i, "").toLowerCase();
  if (/\/(authors?|team|people|board-of-directors|about-us)(\/|$)/.test(path) || /^author\b/i.test(title)) return "author";
  if (/\/(collections?|categor(y|ies)|tags?|topics?|shop|archive)(\/|$)/.test(path)) return "collection";
  if (/\/(videos?|webinars?|smashing-tv)(\/|$)/.test(path)) return "video";
  if (/(calculator|converter|generator|checker|estimator|analy[sz]er|finder|quiz|tool)\b/.test(path + " " + title.toLowerCase())) return "tool";
  return undefined;
};

server.registerTool(
  "jev_seo_intent_check",
  {
    description:
      "Label one page's main search intent (informational, commercial, transactional, navigational, other). Measured 93% agreement with hand labels on three sites. Cross-checked on 2026-09-22 against DataForSEO's independent search_intent classifier on 263 real pages (no hand labels): confirmed the same systematic miss from a second source — Jev calls a service or sales page 'informational' far more often than the reverse (65 cases vs 6 in 263). Code flags this: `informational` plus a detected commercial signal (price, quote, demo, sign-up, contact-sales wording) returns commercial_signal_detected so you know to look, rather than trusting the label.",
    inputSchema: { title: z.string(), content: z.string().describe("Visible page text, plain"), focus_keyword: z.string().optional() },
  },
  async ({ title, content, focus_keyword }) => {
    try {
      const res = (await systemOne({ state: { page: { title, focus_keyword: focus_keyword ?? null, content: clip(content, WORDS.intent) } }, questions: intentQuestions() })) as Res;
      const intent = res.answers.intent?.choice ?? null;
      const signal = COMMERCIAL_SIGNAL.test(content);
      const flagged = intent === "informational" && signal;
      return ok({
        model: res.model ?? PINNED_MODEL,
        intent,
        commercial_signal_detected: signal,
        note: flagged
          ? "Called informational, but the page text has a commercial signal (price, quote, demo, sign-up or contact-sales wording). Confirmed miss pattern (DataForSEO cross-check, round 9): check by eye."
          : intent === "informational"
            ? "If this page sells a service, offers a quote or promotes a provider, check by eye: informational is the usual miss."
            : undefined,
        answers: res.answers,
      });
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "jev_seo_thin_check",
  {
    description:
      "Score how thoroughly a page covers what its title promises (depth 0 to 3) and flag it as thin below 2. Catches 100% of 60-word stubs and 78% of 150-word cuts, flags 1.6% of complete pages. Depth follows length closely (rank correlation 0.81) plus a check that the title's promise is delivered. Pages that are thin by design are never flagged: tool (calculators, widgets), author (bios, team pages), collection (category, tag, product-collection pages), listing and video. Pass page_kind, or pass url and the kind is inferred from the path (and the title for tools). On public sites 61% of short real pages scored below 2, mostly author bios and collection pages; with this exclusion they are reported as exempt instead.",
    inputSchema: {
      title: z.string(),
      content: z.string().describe("Visible page text, plain"),
      page_kind: z.enum(["article", "tool", "author", "collection", "listing", "video", "other"]).optional().describe("Omit to infer from url; defaults to article"),
      url: z.string().optional().describe("The page URL, used only to infer page_kind when it is not given"),
    },
  },
  async ({ title, content, page_kind, url }) => {
    try {
      const words = wordCount(content);
      const inferred = !page_kind ? inferPageKind(url ?? "", title) : undefined;
      const kind = page_kind ?? inferred ?? "article";
      const exempt = EXEMPT_KINDS.has(kind);
      const res = (await systemOne({ state: { page: { title, content: clip(content, WORDS.page) } }, questions: depthQuestions() })) as Res;
      const depth = res.answers.depth?.score ?? 0;
      const low = depth < THRESHOLDS4.thinDepthBelow;
      return ok({ model: res.model ?? PINNED_MODEL, words, depth: r2(depth), page_kind: kind, kind_inferred: inferred !== undefined, thin: low && !exempt, note: low && exempt ? `Low score on a ${kind} page: expected, not flagged.` : undefined });
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "jev_seo_cannibalisation_check",
  {
    description:
      "Judge whether pairs of pages compete for the same search query. Pre-shortlist the pairs in code (for example by TF-IDF similarity), max 10 pairs. Each pair is asked in both orders and averaged. probability >= 0.5 goes on the shortlist (recall 86%, precision 75% on labelled pairs); >= 0.7 is 'likely' (precision 86%, recall 43%). False flags are near-topic pairs with different intent, so a person confirms before any merge, redirect or deletion.",
    inputSchema: { pairs: z.array(z.object({ a: z.object({ id: z.string(), title: z.string(), content: z.string() }), b: z.object({ id: z.string(), title: z.string(), content: z.string() }) })).min(1).max(10) },
  },
  async ({ pairs }) => {
    try {
      const st = (x: { title: string; content: string }, y: { title: string; content: string }) => ({ page_a: { title: x.title, content: clip(x.content, WORDS.pair) }, page_b: { title: y.title, content: clip(y.content, WORDS.pair) } });
      const results = await Promise.all(
        pairs.map(async ({ a, b }) => {
          const [x, y] = (await Promise.all([systemOne({ state: st(a, b), questions: { q: cannibalQuestion } }), systemOne({ state: st(b, a), questions: { q: cannibalQuestion } })])) as Res[];
          const p = (noul(x.answers, "q") + noul(y.answers, "q")) / 2;
          return { a: a.id, b: b.id, probability: r2(p), verdict: p >= THRESHOLDS4.cannibalLikely ? "likely_competing" : p >= THRESHOLDS4.cannibalShortlist ? "shortlist_confirm_by_eye" : "distinct" };
        }),
      );
      return ok({ model: PINNED_MODEL, results: results.sort((m, n) => n.probability - m.probability) });
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "jev_seo_schema_check",
  {
    description:
      "Check which structured-data types the page's visible content truthfully supports: FAQ, HowTo, Review, Product. Use it to catch schema that does not match the page, or to see what a page qualifies for. FAQ and Product are reliable (FAQ right on 12 of 13 disagreements with a heading check, Product false yes on 0.6% of pages). HowTo has false yeses on service pages: review by eye. Review is unproven for positives (no page with visible reviews across the test sites) and uses a 0.85 threshold, but it did correctly answer no on 23 of 24 pages whose JSON-LD claimed reviews or ratings that are not visible, which is exactly the mismatch to look for. Same for FAQ: three pages with FAQPage JSON-LD and no visible FAQ came back no. To audit a page's real schema, compare `supports` with the types in its JSON-LD; a claimed type with supports false is the finding. Send the full visible text.",
    inputSchema: { title: z.string(), content: z.string().describe("Full visible page text, plain") },
  },
  async ({ title, content }) => {
    try {
      const res = (await systemOne({ state: { page: { title, content: clip(content, WORDS.page) } }, questions: schemaQuestions() })) as Res;
      const p = (k: string) => r2(noul(res.answers, k));
      const t = THRESHOLDS4;
      return ok({
        model: res.model ?? PINNED_MODEL,
        supports: { faq: p("faq") >= t.schemaYes, howto: p("howto") >= t.schemaYes, review: p("review") >= t.schemaReviewYes, product: p("product") >= t.schemaYes },
        probability: { faq: p("faq"), howto: p("howto"), review: p("review"), product: p("product") },
        confidence_note: { faq: "reliable", product: "reliable", howto: "check by eye", review: "unproven, high threshold" },
      });
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "jev_seo_voice_check",
  {
    description:
      "Checks whether a piece of copy is consistent with a described writing voice, or drifts into a different register (hedged, corporate, praise-sandwiched, generic marketing). First-pass tested 2026-09-22 on real quotes versus written corporate-drift rewrites of the same points: cleanly separated (real voice scored 0.67 to 0.93, drift scored 0.04 to 0.22), with the drift reason correctly identified (hedging, praise_sandwich, generic_marketing). Pass a voice reference document (or a substantial excerpt) and the text to check; useful before publishing anything under one person's byline.",
    inputSchema: { text: z.string(), voice_reference: z.string().describe("A description of the target voice, with concrete patterns to write toward and avoid. A whole reference doc is fine.") },
  },
  async ({ text, voice_reference }) => {
    try {
      const res = (await systemOne({ state: { voice_reference, text }, questions: voiceQuestions() })) as Res;
      const matches = noul(res.answers, "matches");
      return ok({ model: res.model ?? PINNED_MODEL, matches: matches >= THRESHOLDS5.voiceMatch, confidence: r2(matches), drift_reason: res.answers.drift_reason?.choice ?? null });
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "jev_seo_comparison_fairness_check",
  {
    description:
      "Checks whether a comparison article ('X vs Y') reads as fair (real strengths and limitations on more than one side) or as a sales pitch for one option with the other used as a strawman. First-pass tested 2026-09-22: 6 real comparison articles scored 0.75 to 0.96 (fair), a deliberately one-sided rewrite of the same topic scored 0.06 and correctly named which option it favoured. Send the full page text.",
    inputSchema: { title: z.string(), content: z.string().describe("Full visible page text, plain") },
  },
  async ({ title, content }) => {
    try {
      const res = (await systemOne({ state: { page: { title, content: clip(content, WORDS.page) } }, questions: comparisonFairnessQuestions() })) as Res;
      const fair = noul(res.answers, "fair");
      return ok({ model: res.model ?? PINNED_MODEL, fair: fair >= THRESHOLDS5.fairnessFair, confidence: r2(fair), favoured: fair >= THRESHOLDS5.fairnessFair ? null : (res.answers.favoured?.choice ?? null) });
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "jev_seo_heading_delivery_check",
  {
    description:
      "For each heading, checks whether the text that follows it actually covers what the heading names, rather than being thin, off-topic, or a heading with nothing real under it. Split the page into (heading, body) pairs in code; send up to 30 per call. First-pass tested 2026-09-22 on real article sections versus the same headings paired with a swapped, unrelated body: real sections scored 'delivers' 72% of the time, swapped ones were correctly rejected 90% of the time.",
    inputSchema: { sections: z.array(z.object({ heading: z.string(), body: z.string().describe("The text immediately following this heading, before the next one") })).min(1).max(30) },
  },
  async ({ sections }) => {
    try {
      const questions: Record<string, Question> = {};
      sections.forEach((_, i) => (questions[`s${i}`] = headingDeliversQuestion(`sections[${i}]`)));
      const res = (await systemOne({ state: { sections }, questions })) as Res;
      const results = sections.map((s, i) => { const p = noul(res.answers, `s${i}`); return { heading: s.heading, delivers: p >= THRESHOLDS5.headingDelivers, confidence: r2(p) }; });
      return ok({ model: res.model ?? PINNED_MODEL, flagged: results.filter((r) => !r.delivers).length, results });
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "jev_seo_faq_answer_check",
  {
    description:
      "For each FAQ question/answer pair, checks whether the answer actually answers the question, versus a non-answer, a deflection or an empty restatement. Send up to 30 pairs per call, best sourced from the page's own FAQPage JSON-LD (mainEntity[].name / acceptedAnswer.text) rather than scraped from rendered text, which is unreliable to split correctly. First-pass tested 2026-09-22 on 15 real Q&A pairs from live FAQPage structured data: all 15 correctly scored as real answers (0.64 to 0.95), and deliberately vague non-answers ('That's a great question, it depends...') were all correctly rejected.",
    inputSchema: { pairs: z.array(z.object({ question: z.string(), answer: z.string() })).min(1).max(30) },
  },
  async ({ pairs }) => {
    try {
      const questions: Record<string, Question> = {};
      pairs.forEach((_, i) => (questions[`p${i}`] = faqAnswersQuestion(`pairs[${i}]`)));
      const res = (await systemOne({ state: { pairs }, questions })) as Res;
      const results = pairs.map((s, i) => { const p = noul(res.answers, `p${i}`); return { question: s.question, answers_it: p >= THRESHOLDS5.faqAnswers, confidence: r2(p) }; });
      return ok({ model: res.model ?? PINNED_MODEL, flagged: results.filter((r) => !r.answers_it).length, results });
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "jev_seo_distinctiveness_check",
  {
    description:
      "Checks whether a page's title and description say anything genuinely different from real competitors, or are interchangeable boilerplate. Pass the page and up to 6 competitor pages that actually rank for the same query (for example from a live SERP), not fabricated competitors. First-pass tested 2026-09-22, 2 cases from a real 'what is a CRM' SERP: a generic real description scored distinct 0.17 with shared_generic_phrase 0.93; a rewrite naming a specific stat scored distinct 0.85 with shared_generic_phrase 0.12. Evidence is thin (2 cases); treat this one as provisional.",
    inputSchema: {
      our_page: z.object({ title: z.string(), description: z.string() }),
      competitor_pages: z.array(z.object({ title: z.string(), description: z.string() })).min(1).max(6),
    },
  },
  async ({ our_page, competitor_pages }) => {
    try {
      const res = (await systemOne({ state: { our_page, competitor_pages }, questions: distinctivenessQuestions() })) as Res;
      const distinct = noul(res.answers, "distinct"), shared = noul(res.answers, "shared_generic_phrase");
      return ok({ model: res.model ?? PINNED_MODEL, distinct: distinct >= THRESHOLDS5.distinctYes, confidence: r2(distinct), shared_generic_phrase: shared >= 0.5 });
    } catch (e) {
      return fail(e);
    }
  },
);

const BOT_BLOCK_TITLE = /client challenge|access denied|just a moment|attention required|are you a (human|robot)|404 not found|page not found|verify you are human/i;
server.registerTool(
  "jev_seo_citation_check",
  {
    description:
      "Checks whether an external citation actually supports the claim it's attached to. Splits the judgment by citation type (does the source back up a stated fact, or does it just name/credit a person, organization or image, which is a different and easier bar): v1 conflated the two and that was most of its apparent miss rate. Send the linked page's own title, description and a real excerpt of its text (`linked_page`), fetched from the actual URL: this tool trusts what you send and cannot verify you fetched the right thing. It refuses to judge (`stage: target_unclear`) when the input itself looks like a bot-block or error page, or has almost no content, so a bad fetch does not produce a confident wrong answer. First-pass v2 tested 2026-09-22 on 12 real citations from two editorial sites plus 12 deliberately wrong targets: wrong targets correctly rejected 91% of the time; real citations correctly judged as supporting 64% to 70% (higher once known crawl failures are excluded). Known gap: it does not catch a fetch that returned real-looking text that is actually navigation chrome rather than the article (seen on Wikipedia- and forum-style sites) — sanity-check extraction quality on unfamiliar site structures beyond what the built-in guard catches.",
    inputSchema: {
      source: z.object({ title: z.string() }),
      anchor_context: z.string().describe("The sentence with the claim, with the cited words wrapped in [[double brackets]]"),
      linked_page: z.object({ title: z.string(), description: z.string().optional(), lead: z.string().optional() }).describe("The cited page's own title, description and a real excerpt of its text"),
    },
  },
  async ({ source, anchor_context, linked_page }) => {
    try {
      if (!/\[\[[^\]]+\]\]/.test(anchor_context)) return fail(new JevError("anchor_context must wrap the cited words in [[double brackets]]."));
      const words = `${linked_page.title || ""} ${linked_page.description || ""} ${linked_page.lead || ""}`.split(/\s+/).filter(Boolean).length;
      if (BOT_BLOCK_TITLE.test(linked_page.title || "")) return ok({ stage: "target_unclear", reason: "linked_page's title looks like a bot-block or error page, not real content" });
      if (words < THRESHOLDS6.citationMinWords) return ok({ stage: "target_unclear", reason: "almost no content was given for the linked page" });

      const state = { source, anchor_context, linked_page };
      const t = (await systemOne({ state, questions: { kind: citationTypeQuestion } })) as Res;
      const kind = t.answers.kind?.choice ?? "fact_claim";
      const [sup, id] = await Promise.all([
        systemOne({ state, questions: { supports: citationSupportsQuestion } }) as Promise<Res>,
        systemOne({ state, questions: { identity: citationIdentityQuestion } }) as Promise<Res>,
      ]);
      const score = kind === "entity_mention" ? noul(id.answers, "identity") : noul(sup.answers, "supports");
      return ok({ model: t.model ?? PINNED_MODEL, stage: "judged", kind, supports: score >= THRESHOLDS6.citationSupports, confidence: r2(score) });
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "jev_seo_vague_link_check",
  {
    description:
      "Flags vague link text (click here, read more, load more, a bare verb, a raw URL used as the visible text) judged from the words alone, with no sentence context. Meant for a sitewide audit of every link already on a page (nav, footer, CTAs, body), not the candidate-scoring the internal-link tools do. Max 40 texts per call. Tested 2026-09-22 on a real nav-heavy nonprofit site (habitat.org, sitewide nav plus newsroom/stories/blog listing pages): caught every known-vague phrase found (click here, read more, load more...), flagged 20% of the rest with defensible reasoning (bare verbs, a bare year, raw URLs as anchor text), and generalized past the seed list on its own (caught 'Leer más', the Spanish for 'read more', and several raw affiliate-site URLs used as link text). Some short nav category words (About, Shop) sit right at the boundary; that reflects real ambiguity in bare 1-2 word nav labels, not a tool error.",
    inputSchema: { anchor_texts: z.array(z.string()).min(1).max(40) },
  },
  async ({ anchor_texts }) => {
    try {
      const questions: Record<string, Question> = {};
      anchor_texts.forEach((_, i) => (questions[`a${i}`] = vagueLinkQuestion(`anchor_texts[${i}]`)));
      const res = (await systemOne({ state: { anchor_texts }, questions })) as Res;
      const results = anchor_texts.map((t, i) => { const p = noul(res.answers, `a${i}`); return { anchor_text: t, vague: p < THRESHOLDS7.vagueLinkDescriptive, descriptive: r2(p) }; });
      return ok({ model: res.model ?? PINNED_MODEL, flagged: results.filter((r) => r.vague).length, results });
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "jev_health",
  { description: "One tiny Jev call to confirm the key, endpoint, pinned model version and latency work.", inputSchema: {} },
  async () => {
    try {
      const t0 = Date.now();
      const response = (await systemOne({
        state: "The sky is blue.",
        questions: { colour: { type: "noul", instructions: "Does the text mention a colour?" } },
      })) as Res;
      return ok({ ok: true, pinned_model: PINNED_MODEL, served_by: response.model, latency_ms: Date.now() - t0, response });
    } catch (e) {
      return fail(e);
    }
  },
);

await server.connect(new StdioServerTransport());
