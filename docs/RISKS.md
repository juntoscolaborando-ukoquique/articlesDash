# Risks / Weaknesses

Checkboxes reflect current implementation status.
Priority order for Etapa 4 (Groq) and beyond is noted on each item.

---

## #1 — No authentication; server binds all interfaces
- [ ] **Open — solve before mobile/multi-user deployment**

No authentication on the Express server (`server.mjs`) despite exposing endpoints that can publish and permanently delete live articles. `app.listen(PORT)` with no host argument binds to all interfaces, not just localhost — if this machine is ever reachable on a network, anyone could hit `/api/articles/:id/publish` or the delete endpoints.

**Fix:** add at minimum a static bearer token in `.env` checked in `asyncHandler` or a middleware; bind explicitly to `127.0.0.1` until auth exists, then to `0.0.0.0` deliberately behind it. See ROADMAP.md Etapa 5.

---

## #2 — Fragile browser automation
- [ ] **Open — ongoing maintenance, no single fix**

`spip-admin.mjs` / `spip-client.mjs` drive the SPIP admin UI via CSS selectors and hardcoded `waitForTimeout()` calls (ranging ~400ms–3000ms) rather than robust wait conditions. Any SPIP UI change silently breaks this, and timing-based waits are a known source of flaky failures.

**Fix:** replace fixed timeouts with `waitForSelector()` / `waitForResponse()` incrementally as each script is touched for other reasons. No single release closes this.

---

## #3 — Regex-based HTML validation
- [x] **Fixed in v1.21.0**

`article-validator.mjs`'s `analyzeHtml()` was a single-pass regex with two real bugs: an attribute value containing `>` split the tag mid-way, and tags inside HTML comments were matched as real tags.

**Fix:** replaced with `parse5` (HTML5 spec-compliant parser). `analyzeHtml()` now uses a real DOM walk and surfaces WHATWG parse errors via `onParseError`. See CHANGELOG 1.21.0.

---

## #4 — In-memory publish lock (single-process only)
- [ ] **Open — solve before mobile/multi-user deployment**

The `publishingInProgress` Set only works within a single Node process. Correctly commented as such, but a real constraint the moment the server runs with more than one instance or replica.

**Fix:** replace with a Redis SETNX lock (pattern already documented in ROADMAP.md Etapa 2 and Etapa 5).

---

## #5 — `looksLikeStructuredPaste()` is a warning, not a gate
- [ ] **Open — not blocking Etapa 4**

`looksLikeStructuredPaste()` (`src/lib/text-to-html.mjs`) is called server-side from `PUT /api/articles/:id/draft` and returns a non-blocking warning. Nothing stops a whole other article's JSON from being pasted into `contentHtml` and saved if the warning is dismissed or bypassed via direct API call.

This happened once in practice: `articulo-1788658811564.json` had another article's full JSON pasted into `contentHtml`, zeroing out `topics`, unnoticed until an explicit `validateArticle()` sweep (fixed in 1.8.1). A corrupted `en-progreso` draft can sit unnoticed indefinitely — nothing scans proactively.

**Note for Etapa 4:** Groq writes via `writeBack()`, not the draft endpoint, so this path is bypassed. The real mitigation for Groq output is #3 (now closed).

---

## #6 — Durable side effects in library code not seamed for tests
- [ ] **Open — apply to new modules as they are written**

`publish-use-case.mjs`'s write-back retry path originally had no injectable seam, causing 34 test-pollution entries in `writeback-failures.log.jsonl` before anyone noticed (fixed in 1.8.1 by adding `_logWriteBackFailure`, same pattern as `_writeBack`/`_writeBackToFile`).

`live-write-gateway.mjs`'s audit-log writer remains a candidate for the same gap — nothing currently stops a test from hitting `live-write-audit.log.jsonl`.

**Fix for Etapa 4:** `groq-enrichment.mjs` must accept a `_groqClient` seam from day one. Do not retrofit seams after tests reveal the need. See ROADMAP.md Etapa 4 implementation constraints.
