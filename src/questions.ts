// All Jev rubrics and threshold constants live here, in one place, so they can be reviewed.
// Reminder (jev/notes.md s7): Jev reads literally, cannot count or do maths, and does not write prose.
// Lengths, counts and link tallies are computed in code, never asked of the model.
//
// Every threshold below comes from the evaluation in jev/tools/jev-eval/REPORT.md (about 6,500 labelled or
// known-answer tests on four corpora). Do not change one without rerunning that suite.

import type { Question } from "./client.js";

export const THRESHOLDS = {
  // meta description and title
  metaAcceptScore: 0.66, // normalised (accuracy + intent) / 2
  accuracyFloor: 2.8, // accuracy is scored 0 to 3; below this the page is not described well enough
  accuracyHard: 2.2, // accuracy in [2.2, 2.8) with nothing else wrong is a "review", not a "rewrite" (public-site run: 10% of real descriptions sit there)
  claimReject: 0.5, // unsupported_claim / overpromises at or above this: it promises something the page lacks
  stuffedReject: 0.5,
  // internal links (score S = mean of link, specific, topic)
  linkKeep: 0.6,
  linkKeepShape: 0.6,
  linkKeepSpecific: 0.3, // added after the one-topic-site test: generic core-phrase anchors score high on link and topic but low here
  linkReview: 0.45,
  linkReviewShape: 0.5,
  // anchor finding (link_suggest stages A and B, ported from link-suggest.mjs). maxNone raised 0.15 -> 0.30 on
  // 2026-09-22 after REPORT.md round 8 confirmed it on a second, untuned batch of sites: +10pt find rate, unrelated-page
  // accept rate unchanged. Do not change without rerunning jev-eval/run-anchors-public.mjs.
  linkMaxNone: 0.3,
  linkMinSentence: 0.35,
  linkMinSpan: 0.3,
  // headings
  headingGeneric: 0.5,
};

export const META_LENGTH = { min: 120, max: 160 }; // characters, checked in code
export const TITLE_LENGTH = { min: 20, max: 60 }; // characters including any brand suffix, checked in code

// Content-format words. If a description or title names one and the page never mentions it, code adds an advisory.
// Advisory only: measured to catch about 30% of fresh false claims and to flag legitimate "free" claims the page never states.
export const FORMAT_WORDS = ["case stud", "interview", "video", "webinar", "podcast", "download", "template", "checklist", "spreadsheet", "workbook", "ebook", "e-book", "whitepaper", "white paper", "course", "calculator", "free", "guarantee", "certificate", "infographic", "toolkit", "worksheet", "survey", "testimonial", "discount", "coupon", "trial"];

const lvl = (a: string, b: string, c: string, d: string) => [a, b, c, d];

export const metaQuestions = (): Record<string, Question> => ({
  accuracy: {
    type: "score",
    instructions:
      "How accurately does `meta_description` describe what `page.content` actually covers? Judge only what is written, ignore length and style.",
    criteria: lvl(
      "Describes something the page does not cover, or is unrelated",
      "Vague or generic, could describe many pages",
      "Broadly right but misses the page's main point",
      "Accurately captures the page's main point",
    ),
  },
  intent_match: {
    type: "score",
    instructions:
      "Would `meta_description` make a searcher looking for `focus_keyword` (or, if that is null, for the page's main topic) confident this page answers their need?",
    criteria: lvl(
      "Searcher would skip it, no relevance to the keyword",
      "Keyword topic is mentioned but the promise is unclear",
      "Clear promise relevant to the keyword",
      "Clear, specific promise that directly matches the keyword's intent",
    ),
  },
  has_action_or_benefit: {
    type: "noul",
    instructions: "Does `meta_description` state a concrete benefit or invite the reader to do something?",
  },
  is_keyword_stuffed: {
    type: "noul",
    instructions: "Does `meta_description` repeat the same keyword or phrase in a way that reads as stuffing?",
  },
  unsupported_claim: {
    type: "noul",
    instructions:
      "Does `meta_description` state or promise anything (an item, feature, number, resource, or type of content) that `page.content` does not actually contain?",
    criteria: { true: "It promises something the page does not contain", false: "Everything it states or promises is on the page" },
  },
  page_intent: {
    type: "choice",
    instructions: "What is the main search intent this page serves?",
    criteria: {
      informational: "Reader wants to learn or understand something",
      commercial: "Reader is comparing or evaluating options before deciding",
      transactional: "Reader wants to buy, sign up or book",
      navigational: "Reader wants a specific brand, page or tool",
      other: "None of the above fit",
    },
  },
});

export const titleQuestions = (): Record<string, Question> => ({
  accuracy: {
    type: "score",
    instructions: "How well does the `title` tag describe what `page.content` is about?",
    criteria: lvl("Describes something the page does not cover", "Vague or generic", "Broadly right but misses the main point", "Accurately captures the page's main point"),
  },
  intent_match: {
    type: "score",
    instructions: "Would a searcher typing `focus_keyword` (or the page's main topic if null) see this `title` as a clear, specific answer?",
    criteria: lvl("Searcher would skip it", "Promise unclear", "Clear promise relevant to the keyword", "Clear, specific promise that directly matches the keyword's intent"),
  },
  // v3, shipped 2026-09-22 (REPORT.md, title refinement round): named content types (video, case study, interview...)
  // explicitly listed, and clauses appended after a site-name suffix explicitly covered, but "only what is NAMED, not
  // implied" to keep false flags on real titles down. Measured: subtle over-promise detection on unseen public sites
  // rose from 49% to 79% (isolated signal), while false-flag rate on real titles fell or held everywhere tested.
  overpromises: {
    type: "noul",
    instructions:
      "Does `title` promise something the page does not actually deliver? This covers a download, template, number, guarantee or comparison, and a specific content type explicitly NAMED in the title, such as a video, case study, expert interview, course, calculator, checklist, workbook or free resource. This includes such a phrase appended after a site-name suffix (for example 'Article Title — Site Name with Case Studies': if the page has no case studies, that clause is a false promise). Only flag a promise the title actually states; do not flag a general or implied claim.",
    criteria: { true: "Names a specific thing, number or content type the page does not deliver", false: "Everything explicitly named is actually on the page" },
  },
  keyword_stuffed: { type: "noul", instructions: "Is `title` stuffed with repeated or awkwardly forced keywords?" },
});

// ----- internal links: every candidate gets link + specific + topic; the anchor gets one shape check -----
// `anchor_context` is the sentence with the anchor words wrapped in [[double brackets]].
export const linkQuestion = (path: string): Question => ({
  type: "noul",
  instructions: `A reader is on \`source\` and reaches the phrase in \`anchor_context\` (marked with [[double brackets]]). Would a link from that phrase to \`${path}\` be genuinely useful to them, on-topic and natural, rather than a stretch?`,
  criteria: {
    true: "The candidate page directly helps with the topic at that phrase",
    false: "Only loosely related, off-topic, or would feel forced",
  },
});

export const anchorSpecificQuestion = (path: string): Question => ({
  type: "noul",
  instructions: `Look only at the words inside [[double brackets]] in \`anchor_context\`. Are those words specific to what \`${path}\` is about, so that they clearly point to that page and not equally to many other pages on a related topic?`,
  criteria: { true: "Specific to that page's topic", false: "Generic words that could point to many different pages" },
});

export const anchorTopicQuestion = (path: string): Question => ({
  type: "noul",
  instructions: `Look only at the words inside [[double brackets]] in \`anchor_context\`. Do those words on their own name the topic that \`${path}\` covers?`,
  criteria: { true: "The words name the topic of that page", false: "The words are about something else or nothing in particular" },
});

export const anchorShapeQuestion: Question = {
  type: "noul",
  instructions:
    "Look only at the words inside [[double brackets]] in `anchor_context`. As link text, would they tell a reader what the linked page is about, reading as a natural descriptive phrase (not a sentence fragment, a single vague word, or a filler phrase)?",
  criteria: { true: "Descriptive, natural link text", false: "A fragment, too vague, or awkward as link text" },
};

// ----- round 4 tasks (jev/tools/jev-eval/REPORT.md, "Round 4"). Same rule: do not change without rerunning run-tasks.mjs. -----
export const THRESHOLDS4 = {
  thinDepthBelow: 2, // depth is scored 0 to 3
  cannibalShortlist: 0.5, // recall 86%, precision 75% on labelled pairs
  cannibalLikely: 0.7, // recall 43%, precision 86%
  schemaYes: 0.5, // faq, product, howto
  schemaReviewYes: 0.85, // review at 0.5 gave six false yes on the test sites
};
export const WORDS = { intent: 350, pair: 250, page: 6000 };

const INTENT: Record<string, string> = {
  informational: "Reader wants to learn or understand something",
  commercial: "Reader is comparing or evaluating options or providers before deciding",
  transactional: "Reader wants to buy, get a quote, book, sign up, or use a tool right now",
  navigational: "Reader is looking for one specific brand, page or account",
  other: "Legal, policy, contact or other pages that answer no search query",
};
export const intentQuestions = (): Record<string, Question> => ({
  intent: { type: "choice", instructions: "What is the main search intent this page serves? Judge from what the page is and offers, not from how it is worded.", criteria: INTENT },
});

export const depthQuestions = (): Record<string, Question> => ({
  depth: {
    type: "score",
    instructions: "How thoroughly does `page.content` cover what its `page.title` promises, for a reader who wants a real answer? Judge coverage, not length or style.",
    criteria: lvl("Almost nothing: a stub, a teaser, or a few generic sentences", "Thin: touches the topic but leaves the main questions unanswered", "Adequate: covers the main points, some gaps or shallow spots", "Thorough: covers the topic in real depth with specifics"),
  },
});

export const cannibalQuestion: Question = {
  type: "noul",
  instructions: "Would a searcher typing one query be equally well served by `page_a` or `page_b`, so that the two pages compete for the same search result and one of them is redundant?",
  criteria: { true: "Same query, same intent, largely overlapping answer", false: "Different query, audience, or intent; each page earns its own result" },
};

const yn = { true: "Yes, clearly", false: "No" };
export const schemaQuestions = (): Record<string, Question> => ({
  faq: { type: "noul", instructions: "Does `page.content` contain a set of real questions each followed by its own answer (a FAQ section), such that FAQ structured data would truthfully match the page?", criteria: yn },
  howto: { type: "noul", instructions: "Does `page.content` give numbered or clearly sequenced steps for doing one task, such that HowTo structured data would truthfully match the page?", criteria: yn },
  review: { type: "noul", instructions: "Does `page.content` show actual customer reviews, testimonials or star ratings, such that Review or AggregateRating structured data would truthfully match the page?", criteria: yn },
  product: { type: "noul", instructions: "Does `page.content` offer something for sale with a stated price, such that Product or Offer structured data would truthfully match the page?", criteria: yn },
});

// ----- round 11 (REPORT.md, "Seven new tests"): five that passed a first-pass round, tested 2026-09-22. -----
export const THRESHOLDS5 = {
  voiceMatch: 0.5,
  fairnessFair: 0.5,
  headingDelivers: 0.5,
  faqAnswers: 0.5,
  distinctYes: 0.5,
};

export const voiceQuestions = (): Record<string, Question> => ({
  matches: {
    type: "noul",
    instructions: "Given `voice_reference` (a description of one person's writing voice, with concrete patterns to write toward and avoid), does `text` read as consistent with that voice, or does it drift into a different register (hedged, corporate, softened, generic marketing tone)?",
    criteria: { true: "Consistent with the reference voice", false: "Drifts into a different register than the reference describes" },
  },
  drift_reason: {
    type: "choice",
    instructions: "If it drifts, what is the main reason? If it does not drift, pick closest_match.",
    criteria: {
      hedging: "Hedged, qualified language (might, could, it's worth considering)",
      praise_sandwich: "Softens a correction by wrapping it in praise",
      em_dash: "Uses an em dash",
      generic_marketing: "Generic corporate or marketing tone, manufactured enthusiasm",
      long_transitions: "Long transitional prose where a subhead or short sentence would do",
      closest_match: "No real drift",
    },
  },
});

export const comparisonFairnessQuestions = (): Record<string, Question> => ({
  fair: {
    type: "noul",
    instructions: "This is a comparison article between two or more named options. Does it cover real trade-offs on more than one side (each option gets at least one genuine strength and one real limitation), or does it read as a sales pitch for one option with the other(s) present mainly as a strawman?",
    criteria: { true: "Reads as a fair comparison, each side gets real strengths and limitations", false: "One-sided: one option is favoured, the other(s) mostly there to be dismissed" },
  },
  favoured: {
    type: "choice",
    instructions: "If it is not fair, which named option does it favour? If it is fair, pick neither.",
    criteria: { first: "Favours the first-named option", second: "Favours the second-named option", neither: "Fair, or no clear favourite" },
  },
});

export const headingDeliversQuestion = (path: string): Question => ({
  type: "noul",
  instructions: `In \`${path}\`, \`heading\` introduces \`body\`, the text that immediately follows it on the page. Does that text actually cover what the heading names or promises, giving a reader real information on that specific topic?`,
  criteria: { true: "The section covers what the heading names", false: "Thin, off-topic, or does not really address what the heading promises" },
});

export const faqAnswersQuestion = (path: string): Question => ({
  type: "noul",
  instructions: `In \`${path}\`, does \`answer\` actually answer \`question\`, giving the reader real, specific information, rather than a non-answer, a deflection, or a generic restatement of the question?`,
  criteria: { true: "A real, specific answer", false: "A non-answer, deflection or empty restatement" },
});

export const distinctivenessQuestions = (): Record<string, Question> => ({
  distinct: {
    type: "noul",
    instructions: "Compares `our_page` against `competitor_pages` (the same query's other real top search results). Does our_page say anything a reader would find genuinely different from what the competitors already say, or could a reader swap it for any of the competitors without noticing?",
    criteria: { true: "Says something distinct: a different angle, a specific claim, a concrete detail none of the competitors have", false: "Interchangeable with the competitors; the same generic claim in different words" },
  },
  shared_generic_phrase: {
    type: "noul",
    instructions: "Does `our_page`'s description repeat a generic phrase or claim that most of `competitor_pages` also use (for example a bare definition, or a stock phrase like 'centralizes your data')?",
    criteria: { true: "Yes, a phrase or claim shared with most competitors", false: "No, it does not lean on a shared generic phrase" },
  },
});

// ----- sitewide vague link text (REPORT.md round 13). Bare anchor text, no sentence context: unlike
// anchorShapeQuestion (used by the internal-link tools), this judges a link purely on its own words, for auditing
// every link already on a page (nav, footer, CTAs, body), not just candidate internal links being scored.
export const THRESHOLDS7 = { vagueLinkDescriptive: 0.5 };
export const vagueLinkQuestion = (path: string): Question => ({
  type: "noul",
  instructions: `As link text on its own, with no surrounding sentence, would \`${path}\` tell a reader what the linked page is likely about? Judge only the words themselves.`,
  criteria: { true: "Descriptive: names a real topic or thing", false: "Vague or generic: 'click here', 'read more', a bare verb, a raw URL, or too short to mean anything on its own" },
});

// ----- citation validity, v2 (REPORT.md round 12). v1 conflated two different citation types (does the source back
// up a stated fact, versus does it just identify a named person/org/image credit) and that conflation was most of
// v1's apparent miss rate. Split into a classify question plus the two type-specific checks; code picks the right one.
export const THRESHOLDS6 = { citationSupports: 0.5, citationMinWords: 12 };
export const citationTypeQuestion: Question = {
  type: "choice",
  instructions: "Look at the phrase inside [[double brackets]] in `anchor_context`. What is that link doing?",
  criteria: {
    fact_claim: "States or implies a specific fact, statistic, finding or quote that the linked page is cited to support",
    entity_mention: "Just names or credits a person, organization, product, image or other named thing, without asserting a specific fact about them from the source",
  },
};
export const citationSupportsQuestion: Question = {
  type: "noul",
  instructions: "A reader is on `source` and reaches the claim at the [[bracketed]] words in `anchor_context`. Does `linked_page` (its own title, description and text) actually contain or back up that specific claim?",
  criteria: { true: "Yes, the linked page backs up that specific claim", false: "The linked page does not support that specific claim, or is about something else" },
};
export const citationIdentityQuestion: Question = {
  type: "noul",
  instructions: "Look at the phrase inside [[double brackets]] in `anchor_context`, naming a person, organization, image source or other thing. Is `linked_page` genuinely that entity's own page or clearly about it, rather than something unrelated?",
  criteria: { true: "Yes, linked_page is genuinely about that named entity", false: "linked_page is not really about it, or is unrelated" },
};

// ----- anchor finding: stages A (sentence) and B (span). Stage C reuses linkQuestion / anchorSpecificQuestion /
// anchorTopicQuestion / anchorShapeQuestion above. Ported 1:1 from jev/tools/link-suggest/link-suggest.mjs, confirmed
// on 171 real editor-placed links across 8 public sites (REPORT.md rounds 6-8). -----
export const sentenceQuestion = (opts: Record<string, string>): Record<string, Question> => ({
  best_sentence: {
    type: "choice",
    instructions: "Which sentence of the source page is the most natural place to link to the target page? Pick none if no sentence is a natural fit.",
    criteria: { ...opts, none: "No sentence is a natural place to link to this target." },
  },
});

export const spanQuestion = (opts: Record<string, string>): Record<string, Question> => ({
  best_span: {
    type: "choice",
    instructions: "Which phrase from the sentence is the best anchor text for a link to the target page? It should be descriptive, read naturally as a link, and match what the target page is about.",
    criteria: opts,
  },
});

// ----- headings -----
export const headingQuestion = (path: string): Question => ({
  type: "noul",
  instructions: `Is \`${path}\` a generic or vague label that tells a reader nothing specific about the topic below it (like Conclusion, Introduction, Final Thoughts, or marketing filler such as 'Unlocking the Potential')?`,
  criteria: { true: "Generic or vague, says nothing specific", false: "Names a specific topic" },
});
