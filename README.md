# kev-jev-seo

An MCP server exposing twelve SEO judgment tools built on [Jev](https://typesafe.ai) (TypeSafe's "System One" model). Raw HTTP to `POST /v1/systemone`, no vendor SDK.

Jev doesn't generate text. It takes state plus a typed question (Choice, Score, or Noul) and returns a calibrated probability. This server uses that to judge real SEO problems — thin content, cannibalisation, meta/title accuracy, internal link placement, vague link text, schema-vs-content mismatches, citation validity, voice drift, and more — while leaving counting, thresholds and any generated text to code and to whatever agent is calling the tool.

Every rubric here was tested against known answers (hand-labelled real content, controlled fault injection, and external ground truth we don't control: real search rankings, an external intent classifier, real JSON-LD schema) before shipping, across thirteen rounds and roughly 2,000+ scored test cases on a mix of our own sites and public sites. See "Benchmarks" below for the numbers behind each tool, and the thresholds each is calibrated to.

## Tools

| Tool | Purpose |
| --- | --- |
| `jev_evaluate` | Generic: state plus a map of typed questions (choice, score, noul) |
| `jev_seo_meta_check` | One meta description against the full rendered page text: length in code; Jev scores accuracy, intent, benefit, stuffing and unsupported claims; returns keep/rewrite with reasons, plus an advisory list of format words (video, template, free...) the page never mentions |
| `jev_seo_title_check` | Same for a title tag: accuracy, over-promise, stuffing; length (20 to 60) in code |
| `jev_seo_link_pick` | Internal-link candidates for one source phrase. `anchor_context` must wrap the anchor in `[[double brackets]]`, max 15 candidates. Scores link, specific and topic per candidate plus one anchor-shape check; buckets keep / review / drop |
| `jev_seo_link_suggest` | Given a source page's full text and a target page, finds where to link: best sentence, best anchor phrase, then the same scoring as `jev_seo_link_pick`. `no_suggestion` is a normal answer. Finds 71% to 87% of real editor links across 8 test sites, under 2% wrong-target accepts |
| `jev_seo_heading_check` | Flags generic headings (Conclusion, Final Thoughts, marketing filler), max 40 per call |
| `jev_seo_intent_check` | Search intent label for one page. 93% agreement with hand labels; under-calls service pages as informational |
| `jev_seo_thin_check` | Depth 0 to 3 against the title's promise, thin below 2; tool, author, collection, listing and video pages are exempt (pass `page_kind`, or `url` to infer it) |
| `jev_seo_cannibalisation_check` | Up to 10 pre-shortlisted page pairs, both orders averaged; >= 0.5 shortlist, >= 0.7 likely; a person confirms before any merge |
| `jev_seo_schema_check` | Which of FAQ, HowTo, Review, Product the visible content truthfully supports. FAQ and Product reliable; HowTo check by eye; Review unproven (0.85 threshold) |
| `jev_seo_voice_check` | Does a piece of copy match a described writing voice, or drift (hedged, corporate, praise-sandwiched)? |
| `jev_seo_comparison_fairness_check` | Does a "X vs Y" article cover real trade-offs on both sides, or favour one option? Names which side if unfair |
| `jev_seo_heading_delivery_check` | Per (heading, body) pair, does the section actually cover what the heading names? Max 30 per call |
| `jev_seo_faq_answer_check` | Per (question, answer) pair, does the answer actually answer it? Max 30 per call. Source pairs from the page's own FAQPage JSON-LD, not scraped text |
| `jev_seo_distinctiveness_check` | Is a page's title/description distinct from real competitors (pass real SERP competitors, not fabricated ones), or interchangeable boilerplate? Provisional: only 2 cases tested |
| `jev_seo_citation_check` | Does an external citation actually support the claim it's attached to? Splits fact-claims from entity mentions (naming/crediting a person, org or image), refuses to judge on a bot-blocked or near-empty fetch |
| `jev_seo_vague_link_check` | Flags vague link text (click here, read more, a bare verb, a raw URL) from the bare words alone, no sentence context. For a sitewide audit of every link on a page. Max 40 per call |
| `jev_health` | One tiny call to confirm key, endpoint, latency, pinned model and served model |

All rubrics and thresholds are in `src/questions.ts`. Jev judges only; counts, lengths and maths are done in code, and any generated text comes from whatever agent is calling the tool, not from Jev.

The model is pinned to `jev-1.13.0` (`PINNED_MODEL` in `src/client.ts`, overridable with `TYPESAFE_DEFAULT_MODEL`). If you move to a newer Jev, rerun your own evaluation against it first, then change the pin — the thresholds in `questions.ts` were measured against this specific model version and are not guaranteed to hold on a different one.

## Benchmarks

Headline numbers from evaluation against a mix of internal test sites and eight public sites nobody tuned against (spanning editorial, UX research, SaaS marketing, e-commerce, and other categories):

- **Internal link placement & anchor scoring** — 95-96% approvable across four site corpora on blind holdout rows (99 rows total), 70% rated genuinely good.
- **Anchor-suggestion from scratch** — finds 71-87% of the links a real editor placed, under 2% wrong-target accepts.
- **Meta description checks** — 100% detection of injected wrong-page, generic, and stuffed descriptions; 90-100% on fresh false-claim types never used in tuning.
- **Title checks** — wrong-page, stuffed, and blatant over-promise catch at 98-100% with full page text supplied; subtle over-promise at 79-94% depending on site.
- **Heading quality** — AUC 0.96-0.99 against gold lists, including non-English content.
- **Search intent** — 93% lenient agreement with hand labels; documented bias toward under-calling commercial pages as informational (confirmed independently against an external intent classifier).
- **Thin-content scoring** — AUC 0.91-1.00 catching truncated content, under 3% false-flag rate on complete pages.
- **Schema-vs-content mismatch** — FAQ and Product checks validated against real JSON-LD (AUC 0.95-0.98); Review still unproven.
- **Cannibalisation** — AUC 0.94-0.98; checked against real ranking data from a live keyword API across eight sites, confirmed genuinely rare on sites with reasonable SEO already. Shipped as a triage step, not an auto-merge decision.

A few things that were tested and *didn't* ship: claim-level fact-checking for meta descriptions (no gain over the holistic check), and an earlier citation-validity rubric that conflated "does this support a claim" with "is this genuinely who it's credited to" (fixed by splitting into two question types).

## Install

```bash
npm install
npm run build
```

## Smoke test

After any build, run the known-answer test through the real MCP protocol (55 checks, about 130 API calls):

```bash
TYPESAFE_API_KEY=your-key npm run smoke
```

## Register with Claude Code (or any MCP-compatible client)

```bash
claude mcp add kev-jev-seo -s user -e TYPESAFE_API_KEY=YOUR_KEY -- node /path/to/kev-jev-seo/dist/index.js
```

Then start a new conversation (a running session only loads MCP servers at start) and call `jev_health` to confirm the connection.

## License

MIT
