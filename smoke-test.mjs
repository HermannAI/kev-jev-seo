// Smoke test for the built kev-jev server, through the real MCP protocol. Cases have known right answers.
//   node smoke-test.mjs            (needs TYPESAFE_API_KEY in the environment; run from anywhere)
import fs from "node:fs";
const SDK = "file:///C:/Users/Hp/kev-jev-mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/";
const { Client } = await import(SDK + "index.js"); const { StdioClientTransport } = await import(SDK + "stdio.js");
const pages = JSON.parse(fs.readFileSync("I:/Shared drives/kev/jev/tools/jev-eval/data/abm-rendered-pages.json", "utf8")).pages;
const page = pages.find((p) => /Key Considerations for Retrofitting HVAC/i.test(p.title)) || pages[5];
const text = page.rendered_text, desc = (page.excerpt || page.meta_description || "").trim();

const transport = new StdioClientTransport({ command: "node", args: ["C:/Users/Hp/kev-jev-mcp/dist/index.js"], env: { ...process.env } });
const client = new Client({ name: "smoke", version: "1" }); await client.connect(transport);
const tools = (await client.listTools()).tools.map((t) => t.name); console.log("tools:", tools.join(", "));
const call = async (name, args) => { const r = await client.callTool({ name, arguments: args }); const t = r.content.map((c) => c.text).join(""); try { return { err: !!r.isError, j: JSON.parse(t) }; } catch { return { err: !!r.isError, j: t }; } };
let fails = 0; const check = (label, cond, extra = "") => { console.log((cond ? "PASS " : "FAIL ") + label + (extra ? "  " + extra : "")); if (!cond) fails++; };

const h = await call("jev_health", {}); check("health: pinned model served", h.j.pinned_model === "jev-1.13.0" && h.j.served_by === "jev-1.13.0", `served_by ${h.j.served_by}, ${h.j.latency_ms} ms`);

const good = await call("jev_seo_meta_check", { title: page.title, content: text, meta_description: desc, focus_keyword: "HVAC retrofit" });
console.log("  real description:", desc.slice(0, 90), "->", good.j.verdict, good.j.reasons);
check("meta: returns verdict, reasons, model", ["keep", "rewrite"].includes(good.j.verdict) && Array.isArray(good.j.reasons) && good.j.model === "jev-1.13.0");
const fake = await call("jev_seo_meta_check", { title: page.title, content: text, meta_description: desc.replace(/[.!]$/, "") + ", plus a printable infographic and a free downloadable spreadsheet.", focus_keyword: "HVAC retrofit" });
check("meta: false claim -> rewrite", fake.j.verdict === "rewrite", JSON.stringify(fake.j.reasons));
check("meta: advisory names the missing format words", !!fake.j.advisory?.format_words_not_on_page?.length, JSON.stringify(fake.j.advisory));
const wrong = await call("jev_seo_meta_check", { title: page.title, content: text, meta_description: "Learn how to file a medical malpractice claim step by step, with tips from South African insurers and legal experts.", focus_keyword: "HVAC retrofit" });
check("meta: wrong-page description -> rewrite", wrong.j.verdict === "rewrite", JSON.stringify(wrong.j.reasons));
const none = await call("jev_seo_meta_check", { title: page.title, content: text, meta_description: "" });
check("meta: missing description -> rewrite without a Jev call", none.j.verdict === "rewrite" && none.j.length.status === "missing");

const tOk = await call("jev_seo_title_check", { title: "Retrofitting HVAC Systems in Older Buildings", content: text, focus_keyword: "HVAC retrofit" });
check("title: honest title kept", tOk.j.verdict === "keep", JSON.stringify(tOk.j.reasons));
const tBad = await call("jev_seo_title_check", { title: "Retrofitting HVAC Systems in Older Buildings (Free Template Included)", content: text, focus_keyword: "HVAC retrofit" });
check("title: over-promise -> rewrite", tBad.j.verdict === "rewrite", JSON.stringify(tBad.j.reasons));
const tLong = await call("jev_seo_title_check", { title: "Retrofitting HVAC Systems in Older Buildings: Key Considerations for Facility Managers and Engineers", content: text });
check("title: too long flagged by code", tLong.j.length.status === "long");

const cands = [
  { id: "a", title: "Key Considerations for Retrofitting HVAC Systems in Older Buildings", summary: "Planning and costs of retrofitting HVAC systems in older buildings: assessment, controls, ductwork, phasing." },
  { id: "b", title: "Understanding the Basics of Test, Adjust, and Balance", summary: "What TAB is: testing airflow, adjusting dampers and balancing water and air systems." },
  { id: "c", title: "How Machine Learning Predicts HVAC Failures", summary: "Using sensor data and machine learning to predict equipment failures before they happen." },
];
const lp = await call("jev_seo_link_pick", { source: { title: "How to Reduce Energy Costs in Commercial Buildings", excerpt: "Energy costs in commercial buildings and how to cut them." }, anchor_context: "This involves regular maintenance, [[retrofitting older systems]] with newer, more efficient technology, and smart controls.", candidates: cands });
console.log("  link_pick:", JSON.stringify(lp.j.results?.map((r) => `${r.id} ${r.score} ${r.bucket}`)), "shape", lp.j.anchor_shape);
// This case scores 0.59 to 0.63 run to run, right on the 0.60 keep line, so assert rank and keep-or-review, not the bucket edge.
check("link: intended target ranks first and is keep or review", lp.j.results?.[0]?.id === "a" && ["keep", "review"].includes(lp.j.results[0].bucket));
check("link: unrelated candidate dropped", lp.j.results?.find((r) => r.id === "c")?.bucket === "drop");
const nb = await call("jev_seo_link_pick", { source: { title: "x", excerpt: "y" }, anchor_context: "no brackets here at all", candidates: cands.slice(0, 1) });
check("link: missing [[brackets]] gives a clear error", nb.err && /double brackets/.test(String(nb.j)));

const lsSrc = { title: "How to Reduce Energy Costs in Commercial Buildings", content: "Commercial buildings waste a surprising amount of energy every year through inefficient systems and poor maintenance habits. This involves regular maintenance, retrofitting older systems with newer, more efficient technology, and smart controls. Facility managers who invest early typically see the fastest payback on their investment." };
const lsDecoys = cands.slice(1).map((c) => ({ id: c.id, title: c.title, summary: c.summary }));
const ls = await call("jev_seo_link_suggest", { source: lsSrc, target: { title: cands[0].title, summary: cands[0].summary }, decoys: lsDecoys });
console.log("  link_suggest:", ls.j.stage, JSON.stringify(ls.j.sentence), JSON.stringify(ls.j.anchor), ls.j.target);
check("link_suggest: finds the retrofitting sentence", ls.j.stage === "found" && /retrofit/i.test(ls.j.sentence || ""));
check("link_suggest: anchor mentions retrofitting", ls.j.stage === "found" && /retrofit/i.test(ls.j.anchor || ""));
check("link_suggest: target scored keep or review", ls.j.stage === "found" && ["keep", "review"].includes(ls.j.target?.bucket));
const lsNeg = await call("jev_seo_link_suggest", { source: { title: "Best Pizza Recipes for Home Cooks", content: "A great pizza starts with a well-fermented dough. Let it rise overnight in the fridge for the best flavor. Top it simply: San Marzano tomatoes, fresh mozzarella, and a drizzle of olive oil after baking." }, target: { title: cands[0].title, summary: cands[0].summary } });
check("link_suggest: unrelated source finds nothing", lsNeg.j.stage === "no_suggestion", JSON.stringify(lsNeg.j));

const hd = await call("jev_seo_heading_check", { headings: ["Conclusion", "Take The Next Step", "How Static Pressure Affects Duct Airflow", "Steps for Balancing Multi-Zone HVAC Systems"] });
check("headings: generic flagged, specific not", hd.j.results?.[0]?.flagged && hd.j.results?.[1]?.flagged && !hd.j.results?.[2]?.flagged && !hd.j.results?.[3]?.flagged, JSON.stringify(hd.j.results?.map((r) => `${r.heading.slice(0, 20)}:${r.generic}`)));

// ---- round 4 tools ----
const pg = (re) => pages.find((p) => re.test(p.title));
const air = pg(/Common Air Balance Issues/i), calc = pg(/^Static Pressure Calculator/i), tabA = pg(/Pre-Test Checklist/i), tabB = pg(/How to Prepare HVAC Systems for Air Balance Testing/i), kmp = pg(/Air Duct Size Converter/i), dsc = pg(/^Duct Size Calculator/i);
const intentA = await call("jev_seo_intent_check", { title: air.title, content: air.rendered_text });
check("intent: how-to article is informational", intentA.j.intent === "informational", intentA.j.intent);
const intentB = await call("jev_seo_intent_check", { title: "Terms and Conditions", content: "Website Terms and Conditions. FSP licence 30554. By using this website you agree to the following terms, limitation of liability and governing law." });
check("intent: legal page is other", intentB.j.intent === "other", intentB.j.intent);
const intentC = await call("jev_seo_intent_check", { title: "Air Balance Services for Facility Managers", content: air.rendered_text + " Contact sales to request a quote and get pricing for your building. Book a call with our team today." });
check("intent: commercial signal detected in text", intentC.j.commercial_signal_detected === true, JSON.stringify({ intent: intentC.j.intent, note: intentC.j.note }));

const thinFull = await call("jev_seo_thin_check", { title: air.title, content: air.rendered_text });
check("thin: complete page not flagged", thinFull.j.thin === false, `depth ${thinFull.j.depth}, ${thinFull.j.words} words`);
const thinStub = await call("jev_seo_thin_check", { title: air.title, content: air.rendered_text.split(/\s+/).slice(0, 60).join(" ") });
check("thin: 60-word cut flagged", thinStub.j.thin === true, `depth ${thinStub.j.depth}`);
const thinTool = await call("jev_seo_thin_check", { title: calc.title, content: calc.rendered_text, page_kind: "tool" });
check("thin: tool page never flagged", thinTool.j.thin === false, `depth ${thinTool.j.depth}`);

const stub = air.rendered_text.split(/\s+/).slice(0, 60).join(" ");
for (const [url, kind] of [["https://example.com/author/jane-doe/", "author"], ["https://example.com/collections/spring-shoes", "collection"], ["https://example.com/videos/intro", "video"]]) {
  const t = await call("jev_seo_thin_check", { title: "Short page", content: stub, url });
  check(`thin: ${kind} url inferred and not flagged`, t.j.page_kind === kind && t.j.kind_inferred === true && t.j.thin === false, `depth ${t.j.depth}`);
}
const thinUrlArticle = await call("jev_seo_thin_check", { title: air.title, content: stub, url: "https://example.com/blog/air-balance-issues/" });
check("thin: article url still flagged when thin", thinUrlArticle.j.page_kind === "article" && thinUrlArticle.j.thin === true);
const thinExplicit = await call("jev_seo_thin_check", { title: air.title, content: stub, page_kind: "author" });
check("thin: explicit page_kind overrides", thinExplicit.j.page_kind === "author" && thinExplicit.j.kind_inferred === false && thinExplicit.j.thin === false);

const cn = await call("jev_seo_cannibalisation_check", { pairs: [
  { a: { id: "dsc", title: dsc.title, content: dsc.rendered_text }, b: { id: "kmp", title: kmp.title, content: kmp.rendered_text } },
  { a: { id: "air", title: air.title, content: air.rendered_text }, b: { id: "calc", title: calc.title, content: calc.rendered_text } },
  { a: { id: "self", title: air.title, content: air.rendered_text }, b: { id: "self2", title: "Complete Guide to " + air.title, content: air.rendered_text } },
] });
const pr = (id) => cn.j.results.find((r) => r.a === id);
console.log("  cannibal:", JSON.stringify(cn.j.results.map((r) => `${r.a}/${r.b} ${r.probability} ${r.verdict}`)));
check("cannibal: same page retitled is likely competing", pr("self")?.verdict === "likely_competing");
check("cannibal: unrelated pair is distinct", pr("air")?.verdict === "distinct");
check("cannibal: two duct-size tools at least shortlisted", pr("dsc")?.probability >= 0.5);

const faqPage = pages.find((p) => /\bFAQs?\b/.test(p.rendered_text) && /Common Air Balance Issues/i.test(p.title)) || air;
const sc1 = await call("jev_seo_schema_check", { title: faqPage.title, content: faqPage.rendered_text });
check("schema: real FAQ section detected", sc1.j.supports?.faq === true, JSON.stringify(sc1.j.probability));
check("schema: no price so no Product", sc1.j.supports?.product === false);
const sc2 = await call("jev_seo_schema_check", { title: "Terms and Conditions", content: "Website Terms and Conditions. By using this website you agree to the following terms and limitation of liability." });
check("schema: legal page supports nothing", Object.values(sc2.j.supports).every((v) => v === false), JSON.stringify(sc2.j.probability));

// ---- round 11 tools ----
const voiceRef = "Direct. Impatient with fluff. Corrects bluntly, without hedging. No em dashes, ever. Short sentences, fragments are fine. Praise is short and pivots to the next action. Avoid: hedged qualifiers (might, could, it's worth considering), praise-sandwiched corrections, manufactured enthusiasm.";
const voiceGood = await call("jev_seo_voice_check", { text: "wow. cant believe I missed that. thanks. fixed. see new uploaded image", voice_reference: voiceRef });
check("voice: real quote matches the reference voice", voiceGood.j.matches === true, JSON.stringify(voiceGood.j));
const voiceBad = await call("jev_seo_voice_check", { text: "Great catch, really appreciate you flagging that — I've gone ahead and made the fix, and uploaded a new image for you to review whenever you get a chance!", voice_reference: voiceRef });
check("voice: corporate rewrite flagged as drift", voiceBad.j.matches === false && voiceBad.j.drift_reason !== "closest_match", JSON.stringify(voiceBad.j));

const fairPage = await call("jev_seo_comparison_fairness_check", { title: "Angel Investors vs Venture Capital: What's the Difference", content: "Angel investors are individuals investing their own money, usually earlier and smaller, with more flexible terms but less follow-on capital. Venture capital firms invest institutional money, usually later and larger, with more rigorous due diligence and board involvement, but also more capital for scaling. Founders who want speed and flexibility often prefer angels; founders who need large capital for aggressive growth often need VC. Each has real trade-offs depending on the stage and goals of the company." });
check("fairness: balanced comparison scored fair", fairPage.j.fair === true, JSON.stringify(fairPage.j));
const unfairPage = await call("jev_seo_comparison_fairness_check", { title: "Angel Investors vs Bank Loans: Why Angel Investors Win Every Time", content: "Angel investors are simply the smarter choice for any serious founder. They bring expert mentorship and money with no repayment stress. Bank loans saddle you with rigid repayment schedules and zero strategic help; a bank does not care if your startup succeeds. Angel investors believe in your vision. Bank loans are for founders who could not get anyone to believe in them. Angel investment is the obvious path forward, every time, no contest." });
check("fairness: one-sided page flagged and favoured side named", unfairPage.j.fair === false && unfairPage.j.favoured === "first", JSON.stringify(unfairPage.j));

const hdc = await call("jev_seo_heading_delivery_check", { sections: [
  { heading: "How Static Pressure Affects Duct Airflow", body: "Static pressure is the resistance air meets as it moves through ductwork. Higher static pressure means the fan works harder to push the same volume of air, which cuts efficiency and can shorten equipment life. Measuring it at the return and supply plenums tells you whether the duct sizing matches the system's design airflow." },
  { heading: "How Static Pressure Affects Duct Airflow", body: "Contact us today for a free quote. Our certified technicians are standing by to help with all your HVAC needs across the region." },
] });
check("heading delivery: on-topic section delivers, swapped body flagged", hdc.j.results?.[0]?.delivers === true && hdc.j.results?.[1]?.delivers === false, JSON.stringify(hdc.j.results));

const fq = await call("jev_seo_faq_answer_check", { pairs: [
  { question: "Does HubSpot integrate with MLS systems and real estate tools?", answer: "Yes, HubSpot integrates with popular real estate platforms including MLS systems, allowing agents to sync listings and buyer data automatically." },
  { question: "Does HubSpot integrate with MLS systems and real estate tools?", answer: "That's a great question, and it really depends on your specific situation." },
] });
check("FAQ answers: real answer kept, non-answer flagged", fq.j.results?.[0]?.answers_it === true && fq.j.results?.[1]?.answers_it === false, JSON.stringify(fq.j.results));

const dist = await call("jev_seo_distinctiveness_check", { our_page: { title: "What is CRM? | Guide to Customer Relationship Management", description: "What is a CRM System? Customer Relationship Management (CRM) software centralizes customer data and interactions across all touchpoints in your business." }, competitor_pages: [{ title: "What Is CRM (Customer Relationship Management)?", description: "CRM is an AI-powered system that helps businesses and their employees manage interactions with customers and prospects to improve relationships, streamline sales." }, { title: "What is CRM? | CRM System - Definition - Benefits - Features", description: "CRM stands for Customer Relationship Management software. Businesses use CRM software to streamline sales, marketing, and customer support activities." }] });
check("distinctiveness: generic description flagged as interchangeable", dist.j.distinct === false && dist.j.shared_generic_phrase === true, JSON.stringify(dist.j));

const citeOk = await call("jev_seo_citation_check", { source: { title: "How Static Pressure Affects Duct Airflow" }, anchor_context: "According to [[ASHRAE Standard 111]], TAB reports should be filed before final inspection.", linked_page: { title: "ASHRAE Standard 111", description: "ASHRAE Standard 111 covers testing, adjusting and balancing of building HVAC systems, including TAB report requirements and pre-inspection filing procedures.", lead: "ASHRAE Standard 111 establishes the procedures for testing, adjusting and balancing (TAB) of HVAC systems, including requirements for filing TAB reports before final building inspection." } });
check("citation: real supporting source judged supports", citeOk.j.stage === "judged" && citeOk.j.kind === "fact_claim" && citeOk.j.supports === true, JSON.stringify(citeOk.j));
const citeWrong = await call("jev_seo_citation_check", { source: { title: "How Static Pressure Affects Duct Airflow" }, anchor_context: "According to [[ASHRAE Standard 111]], TAB reports should be filed before final inspection.", linked_page: { title: "Best Pizza Recipes for Home Cooks", description: "A great pizza starts with a well-fermented dough, left to rise overnight in the fridge.", lead: "Top it simply: San Marzano tomatoes, fresh mozzarella, and a drizzle of olive oil after baking." } });
check("citation: unrelated target judged not supporting", citeWrong.j.stage === "judged" && citeWrong.j.supports === false, JSON.stringify(citeWrong.j));
const citeEntity = await call("jev_seo_citation_check", { source: { title: "Notes on TAB Reporting" }, anchor_context: "We spoke with [[Jane Ghazi]], lead technician at Air Balance Masters, about common TAB mistakes.", linked_page: { title: "Jane Ghazi - Lead Technician", description: "Jane Ghazi is the lead TAB technician at Air Balance Masters, with 12 years of field experience in commercial HVAC balancing.", lead: "Jane Ghazi joined Air Balance Masters in 2014 and now leads the company's TAB technician team, specializing in commercial and healthcare facility balancing." } });
check("citation: entity mention classified and identity matched", citeEntity.j.kind === "entity_mention" && citeEntity.j.supports === true, JSON.stringify(citeEntity.j));
const citeBlocked = await call("jev_seo_citation_check", { source: { title: "x" }, anchor_context: "See [[the source]] for details.", linked_page: { title: "Client Challenge", description: "", lead: "A required part of this site couldn't load. Please check your connection." } });
check("citation: bot-block target refuses to judge", citeBlocked.j.stage === "target_unclear", JSON.stringify(citeBlocked.j));
const citeThin = await call("jev_seo_citation_check", { source: { title: "x" }, anchor_context: "See [[the source]] for details.", linked_page: { title: "Home", description: "", lead: "" } });
check("citation: near-empty target refuses to judge", citeThin.j.stage === "target_unclear", JSON.stringify(citeThin.j));
const citeNoBrackets = await call("jev_seo_citation_check", { source: { title: "x" }, anchor_context: "no brackets here", linked_page: { title: "Y", description: "Y is a thing.", lead: "Y is a thing that does stuff, described here in more than a few words for the guard." } });
check("citation: missing [[brackets]] gives a clear error", citeNoBrackets.err && /double brackets/.test(String(citeNoBrackets.j)));

const vl = await call("jev_seo_vague_link_check", { anchor_texts: ["click here", "Read more", "Load more", "https://www.example-affiliate-site.org", "2019", "How Static Pressure Affects Duct Airflow", "Terms of Service", "Workplace giving"] });
console.log("  vague_link:", JSON.stringify(vl.j.results?.map((r) => `"${r.anchor_text}" vague=${r.vague} d=${r.descriptive}`)));
check("vague link: known-vague and bare year/url flagged", vl.j.results?.slice(0, 5).every((r) => r.vague === true), JSON.stringify(vl.j.results?.slice(0, 5)));
check("vague link: real descriptive texts kept", vl.j.results?.slice(5).every((r) => r.vague === false), JSON.stringify(vl.j.results?.slice(5)));

await client.close();
console.log(fails ? `\n${fails} check(s) FAILED` : "\nall checks passed"); process.exit(fails ? 1 : 0);
