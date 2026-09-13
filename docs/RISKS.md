# Risks / Weaknesses

## Priority order for Etapa 4 (Groq implementation) and beyond

The risks below are ordered by when they become blocking constraints:

- **Etapa 4 (now):** ~~#3~~ resolved (see below) — Groq will generate HTML; the validator can now catch bad output reliably.
- **Before mobile/multi-user:** #1 and #4 — authentication and the single-process lock must be solved before the server is exposed to more than one user or instance.
- **Ongoing / background:** #2 — browser automation fragility is a permanent maintenance cost; no single fix, mitigated incrementally.
- **Not blocking Etapa 4:** #5, #6 — remain real risks but don't interact with the Groq pipeline directly.

---

## #1 — No authentication; server binds all interfaces
**Priority: solve before mobile/multi-user deployment**

No authentication on the Express server (`server.mjs`) despite exposing endpoints that can publish and permanently delete live articles. It's documented as a "single-user local tool," but `app.listen(PORT)` with no host argument binds to all interfaces, not just localhost — if this machine is ever reachable on a network, anyone could hit `/api/articles/:id/publish` or the delete endpoints.

> **Etapa 4 note:** Not blocking for Groq itself (which runs server-side and never touches auth). Becomes critical the moment this server is exposed as a mobile app's backend. Solve before that transition: add at minimum a static bearer token in `.env` checked on every request, and bind to `127.0.0.1` explicitly until a proper auth layer exists.

---

## #2 — Fragile browser automation
**Priority: ongoing maintenance, no single fix**

`spip-admin.mjs` / `spip-client.mjs` drive the SPIP admin UI via CSS selectors and hardcoded `waitForTimeout()` calls (ranging ~400ms–3000ms across both files) rather than robust wait conditions. Any SPIP UI change silently breaks this, and timing-based waits are a known source of flaky failures under load.

> **Etapa 4 note:** Groq does not interact with Playwright directly, so this risk doesn't worsen in Etapa 4. It remains a background maintenance cost — replace fixed timeouts with `waitForSelector()` / `waitForResponse()` incrementally as each script is touched for other reasons.

---

## #3 — ~~Regex-based HTML validation~~ ✅ Resuelto (v1.21.0, 2026-09-13)
**Priority: solved during Etapa 3, ahead of Etapa 4**

`article-validator.mjs`'s `analyzeHtml` now parses with `parse5` (the
spec-compliant HTML5 parser also used by jsdom) instead of a hand-rolled
regex. Fixed two concrete bugs the regex had by construction — a quoted
attribute value containing `>` (e.g. `href="foo>bar"`) used to cut the tag
match short; a fake tag inside an HTML comment could be picked up as real
markup — and `analyzeHtml` now also surfaces parse5's own `onParseError`
codes as a validation error, catching genuinely malformed syntax (bad
characters in tag/attribute names) that the regex had no way to see.

Deliberately **not** treated as an error: an unclosed `<p>` or a stray
`</div>` with no matching open tag. The HTML5 parsing spec itself is
forgiving of these — a browser (and SPIP) resolve them implicitly, so
flagging them would reject content the spec itself considers valid. Verified
against all 85 real `contentHtml`/`chapo`/`ps` fields already on disk before
merging: zero false positives.

See CHANGELOG 1.21.0 and `test/article-validator.test.mjs` for the
regression tests covering both fixed bugs.

---

## #4 — In-memory publish lock (single-process only)
**Priority: solve before mobile/multi-user deployment**

The in-memory `publishingInProgress` Set is explicitly "sufficient for a single-user local tool" but would break under multiple server instances — correctly flagged in a comment rather than silently risky.

> **Etapa 4 note:** Not blocking for Groq. Becomes a real constraint the moment the server runs as a mobile app's backend with more than one process or replica. Solve at the same time as #1: replace the Set with a Redis SETNX lock (pattern already documented in ROADMAP.md Etapa 2) before any multi-instance deployment.

---

## #5 — `looksLikeStructuredPaste()` is a warning, not a gate
**Priority: not blocking Etapa 4**

`looksLikeStructuredPaste()` (`src/lib/text-to-html.mjs`) is called server-side from `PUT /api/articles/:id/draft`, not client-side. It is a non-blocking warning returned in the response body (`data.warning`), displayed as a toast by the frontend — not a server-side gate. Nothing in `article-validator.mjs` or the write path stops a whole other article's JSON from being pasted into `contentHtml` and saved as-is if the warning is dismissed or bypassed (e.g. direct API calls, or the CLI publish script).

This already happened once in practice: `articulo-1788658811564.json` had another article's full JSON object pasted into its `contentHtml`, which zeroed out `topics` and went unnoticed until an explicit `validateArticle()` sweep over `articles/*.json` turned it up (fixed in 1.8.1 — CHANGELOG). The self-heal in `listArticles()` demotes an already-`terminado` article that fails validation, which is why this one was caught before publishing, but a corrupted `en-progreso` draft can sit unnoticed indefinitely since nothing scans for it proactively.

> **Etapa 4 note:** Groq writes to fields directly via `writeBack()`, not through the draft endpoint, so this specific warning path is bypassed entirely. The real mitigation for Groq output is #3 (parser-based validation).

---

## #6 — Durable side effects in library code not reliably seamed for tests
**Priority: not blocking Etapa 4**

`publish-use-case.mjs`'s write-back retry path originally called `logWriteBackFailure()` directly with no way to intercept it, so the test exercising that failure path appended real entries to `writeback-failures.log.jsonl` on every `node --test` run — 34 identical test-pollution entries accumulated over several days before anyone looked at the file (fixed in 1.8.1 by adding a `_logWriteBackFailure` seam, same pattern as `_writeBack`/`_writeBackToFile`).

Worth auditing other `fs.appendFileSync`/`fs.writeFileSync` call sites in `src/lib/` for the same gap — `live-write-gateway.mjs`'s audit-log writer is the most obvious remaining candidate, since nothing currently stops a test from hitting the real `live-write-audit.log.jsonl` the same way.

> **Etapa 4 note:** `groq-enrichment.mjs` should be written with injectable seams from the start (`_groqClient` parameter, same pattern as `_spipClient` in `publish-use-case.mjs`) so it can be tested without a real Groq API key. Don't repeat the pattern of adding seams after the fact.
