# GROQ-STEPS.md — Etapa 4 Implementation Plan

**Status:** In Progress (4/7 tasks complete)  
**Last Updated:** 2026-09-14  
**Implements:** Etapa 4 del ROADMAP — LLM enrichment vía Groq

---

## Overview

Etapa 4 inserts Groq-powered enrichment into two workflow transitions:

1. **Transición 1** (Edición → En Progreso, `POST /api/articles/:id/send-to-revision`)
   - Calls `enrichDraft()` to parse raw text into structured fields
   - Replaces the heuristic `splitContentIntoFields()` from `field-splitter.mjs`
   - Same return shape: `{ chapo, contentHtml, ps, guessed, ... }`

2. **Transición 2** (En Progreso → Terminado, `POST /api/articles/:id/promote`)
   - Calls `finalizeArticle()` to verify and complete remaining gaps
   - Patches missing: `descriptif`, `chapo`, `topics`, `section`
   - Validates patched article before final approval

---

## Implementation Steps

### Step 1: Core Module — `groq-enrichment.mjs` ✅

**File:** `src/lib/groq-enrichment.mjs` (614 lines)

**Exports:**

- `enrichDraft(rawText, partialArticle, { _groqClient })`
  - Input: raw text from editor, partial article object
  - Output: `{ chapo, contentHtml, ps, guessed, extra, groqWarnings, model }`
  - On error: throws `{ code: 'GROQ_API_ERROR' | 'GROQ_PARSE_ERROR', message, cause? }`

- `finalizeArticle(article, { _groqClient })`
  - Input: complete article object (En Progreso state)
  - Output: `{ patch, groqWarnings, model }`
  - On error: throws `{ code: 'GROQ_API_ERROR' | 'GROQ_PARSE_ERROR', message, cause? }`

**Key Features:**

- Dynamic import of `groq-sdk` (lazy, only when called)
- Injectable `_groqClient` seam for unit testing
- 20 second timeout per call + 1 automatic retry
- `reasoning_effort: 'none'` to suppress Qwen3 `<think>` blocks
- `validateHtml()` gate on all `contentHtml` output
- Two separate prompts with different `temperature` and `max_tokens`:
  - `enrichDraft` prompt: `temperature: 0.3, max_tokens: 4096` (structured parsing)
  - `finalizeArticle` prompt: `temperature: 0.2, max_tokens: 2048` (conservative completion)

**Helpers:**

- `stripThinkBlock(raw)` — removes `<think>...</think>` blocks
- `callWithRetry(groq, params)` — wraps Groq API with timeout + retry
- `parseJsonResponse(raw, expectArray)` — extracts JSON from response
- `sanitiseContentHtml(html)` — validates HTML through `validateHtml()`

---

### Step 2: Server Wiring — `send-to-revision` ✅

**File:** `src/server.mjs` (send-to-revision handler, lines ~300–360)

**Changes:**

1. Check for `GROQ_API_KEY` and `req.body.skipGroq` flag
2. If Groq available and not skipped:
   - Call `enrichDraft(article.contentHtml, article)`
   - Write back all returned fields respecting "never overwrite" rule
   - Populate `extra` fields (title, surtitre, descriptif, topics, section)
3. On Groq failure:
   - Return HTTP 202 with `{ groqFailed: true, groqError, groqCode, hint }`
   - Frontend shows error dialog with "continue anyway" button
4. On success:
   - Write back all fields
   - Call `sendToRevision(id)` to move to "En Progreso"
   - Return `{ success: true, workflowStatus: 'en-progreso', groqWarnings? }`

**Fallback (if no Groq or skipGroq=true):**

- Use existing `splitContentIntoFields()` heuristic splitter
- Same write-back logic, no field overwrite

---

### Step 3: Server Wiring — `promote` ✅

**File:** `src/server.mjs` (promote handler, lines ~228–250)

**Changes:**

1. Check for `GROQ_API_KEY` and `req.body.skipGroq` flag
2. If Groq available and not skipped:
   - Call `finalizeArticle(article)` before final `validateArticle()`
   - Write back any patches returned
   - Re-read article from disk to capture patched values
   - Run `validateArticle()` on patched article
   - Only promote if validation passes
3. On Groq failure:
   - Return HTTP 202 with `{ groqFailed: true, ... }`
   - Frontend shows error dialog with "approve anyway" button
4. On validation success:
   - Call `promoteToTerminado(id)`
   - Return `{ success: true, workflowStatus: 'terminado', groqWarnings? }`

**Fallback (if no Groq or skipGroq=true):**

- Skip Groq finalization, go directly to `validateArticle()`
- Promote only if validation passes

---

### Step 4: Test Suite — `groq-enrichment.test.mjs` 🔲 NEXT

**File:** `test/groq-enrichment.test.mjs` (~250 lines)

**Test Strategy:**

- Mock `_groqClient` with canned responses
- Test both success and error paths
- Verify JSON parsing robustness (with `<think>` blocks, malformed JSON, etc.)

**Test Cases:**

1. **enrichDraft — happy path**
   - Input: raw text with metadata hints
   - Output: all fields populated correctly
   - Assert: `chapo`, `contentHtml`, `ps`, `guessed`, `extra` all filled

2. **enrichDraft — partial input**
   - Input: raw text with no metadata
   - Output: fields present in article still present, Groq fills gaps
   - Assert: "never overwrite" rule enforced

3. **enrichDraft — think-block stripping**
   - Input: mock response with `<think>...<meta>...</think>`
   - Output: `<think>` removed, JSON parsed
   - Assert: no reasoning text in output

4. **enrichDraft — malformed JSON**
   - Input: mock response with invalid JSON
   - Throws: `{ code: 'GROQ_PARSE_ERROR', ... }`

5. **enrichDraft — HTML validation**
   - Input: mock response with forbidden tags (`<div>`, `<script>`)
   - Output: `contentHtml` passes `validateHtml()` gate
   - Assert: warnings populated, article still usable

6. **enrichDraft — API timeout and retry**
   - Mock: first call times out, second succeeds
   - Output: success after retry
   - Assert: retry logic works, no second timeout

7. **enrichDraft — no GROQ_API_KEY**
   - Environment: `GROQ_API_KEY` undefined, no `_groqClient`
   - Throws: `{ code: 'GROQ_API_ERROR', message: 'not defined' }`

8. **finalizeArticle — gaps completion**
   - Input: article with missing `descriptif`, `topics`
   - Output: `patch` with filled values
   - Assert: only missing fields in patch, no overwrites

9. **finalizeArticle — validation pass**
   - Input: article with gaps that Groq fills
   - Output: `patch` makes `validateArticle()` pass
   - Assert: patch integrates cleanly

10. **finalizeArticle — all fields valid**
    - Input: article already complete
    - Output: `{ patch: {}, groqWarnings: [] }`
    - Assert: empty patch when nothing to do

---

### Step 5: Frontend Handling — `app.js` (Escribir.tsx equivalent) 🔲

**Files:** `public/js/app.js` or equivalent React component

**Changes:**

1. **Error Handling — 202 Response:**
   - On `res.status === 202` and `res.groqFailed === true`:
     - Show modal dialog: "Groq no pudo procesar el artículo"
     - Display error: `res.groqError` (user-friendly)
     - Offer two buttons:
       - "Continuar sin Groq" — re-post with `{ skipGroq: true }`
       - "Cancelar" — dismiss, stay in current state

2. **Success Handling — groqWarnings:**
   - If response contains `groqWarnings` array:
     - Show toast or banner: "Groq detectó posibles problemas"
     - Display warnings list (e.g., "Forbidden tag `<div>` removed")
     - User can review in the fields below

3. **Success Handling — groqSkipped:**
   - If user clicked "Continuar sin Groq", skip Groq in `promote` too
   - Pass `skipGroq: true` in promote request

4. **UI Indicators:**
   - Show spinner while waiting for Groq (20s max)
   - Disable buttons during Groq call

---

### Step 6: Validation — `article-validator.mjs` ✅ (partial)

**File:** `src/lib/article-validator.mjs`

**Changes:**

- Export `validateHtml()` function (was private, now public)
- No changes to validation logic — same rules apply

---

### Step 7: Integration — `send-to-revision` and `promote` ✅

**File:** `src/server.mjs`

**Workflow:**

```
Edición → send-to-revision
  ├─ Groq: enrichDraft()
  │  ├─ Success: write back fields, move to "En Progreso"
  │  └─ Failure: return 202, offer "continue without"
  └─ No Groq: use splitContentIntoFields(), same result

En Progreso → promote
  ├─ Groq: finalizeArticle()
  │  ├─ Success: patch fields, validate, move to "Terminado"
  │  └─ Failure: return 202, offer "approve without"
  └─ No Groq: validate as-is, move to "Terminado" if valid
```

---

## Remaining Tasks

### Task 5: Unit Tests (NEXT)
- **File:** `test/groq-enrichment.test.mjs`
- **Coverage:** enrichDraft (6 cases), finalizeArticle (4 cases), error handling
- **Effort:** ~2 hours
- **Blocker:** None (module complete, can test immediately)

### Task 6: Frontend Error Handling
- **Files:** `public/js/app.js` or React component
- **Coverage:** 202 error responses, groqWarnings display, skipGroq flag propagation
- **Effort:** ~1.5 hours
- **Blocker:** None (server code complete, can implement UI)

### Task 7: Commit & Push
- **Branch:** Feature branch (feature/groq-enrichment)
- **Commit Message:** "feat: Implement Etapa 4 — Groq LLM enrichment"
- **PR Description:** Details of both transitions, error handling, fallback to heuristic

---

## Error Codes

All Groq errors throw objects with `.code`:

| Code | HTTP | Meaning | Recovery |
|------|------|---------|----------|
| `GROQ_API_ERROR` | 202 | Network/auth/rate-limit failure | Retry with `skipGroq: true` |
| `GROQ_PARSE_ERROR` | 202 | Response not valid JSON | Retry with `skipGroq: true` |
| `VALIDATION_ERROR` | 422 | Article fails schema validation | User edits fields manually |

---

## Configuration

**Required Environment Variable:**

```bash
GROQ_API_KEY=gsk_...  # Groq API key
```

**Optional Disabling:**

- If `GROQ_API_KEY` undefined: skips all Groq calls, uses heuristic splitter
- If `req.body.skipGroq === true`: skips Groq for this call only

---

## Model Choice

- **Model:** `qwen/qwen3.8-27b`
- **Context:** 131k tokens
- **Reasoning:** Qwen3.8 supports `reasoning_effort: 'none'` to suppress expensive thinking

---

## Prompts

### enrichDraft Prompt

Asks Groq to extract structured fields from raw text:
- Requires exact JSON output (no preamble/postamble)
- Enforces allowed HTML tags hint
- Preserves existing title/section if provided
- Returns: `title`, `soustitre`, `surtitre`, `descriptif`, `chapo`, `contentHtml`, `ps`, `topics`, `section`, `language`, `author`, `sourceSite`, `sourceUrl`, `sourceDate`

### finalizeArticle Prompt

Asks Groq to complete only missing fields:
- Only patches gaps, never overwrites complete fields
- Returns: empty object `{}` if nothing to fix
- Returns: partial patch with only changed fields

---

## Testing Strategy

### Unit Tests (Task 5)
- Mock Groq client with canned JSON responses
- Test happy path, error cases, edge cases (think blocks, validation, timeouts)
- Run: `npm test -- test/groq-enrichment.test.mjs`

### Integration Tests (Post-Task 7)
- Full dashboard workflow: create article → send to revision → promote
- Mock Groq responses at endpoint level
- Verify fields are correctly patched and written to disk

### Manual Testing (Post-Task 6)
- Create test article with raw text
- Watch Groq enrich fields in real-time
- Test "continue without Groq" fallback path
- Verify groqWarnings display

---

## Files Modified / Created

| File | Status | Purpose |
|------|--------|---------|
| `src/lib/groq-enrichment.mjs` | ✅ Created | Core Groq integration |
| `src/lib/article-validator.mjs` | ✅ Modified | Export validateHtml |
| `src/server.mjs` | ✅ Modified | Wire Groq into send-to-revision & promote |
| `test/groq-enrichment.test.mjs` | 🔲 TODO | Unit tests |
| `public/js/app.js` | 🔲 TODO | Frontend error handling |
| `GROQ-STEPS.md` | ✅ Created | This file |

---

## Success Criteria

- [ ] All 10 unit test cases pass
- [ ] send-to-revision succeeds with Groq, enriches fields
- [ ] send-to-revision gracefully handles Groq failure with 202
- [ ] promote succeeds with Groq, finalizes gaps
- [ ] promote gracefully handles Groq failure with 202
- [ ] Frontend shows error dialog and "continue without" option
- [ ] Frontend displays groqWarnings in UI
- [ ] Heuristic fallback works when Groq skipped
- [ ] No breaking changes to existing workflow
- [ ] All existing tests still pass

---

## Next Actions

1. **Immediate:** Write `test/groq-enrichment.test.mjs` (Task 5)
2. **Then:** Update frontend error handling (Task 6)
3. **Finally:** Commit, push, and create PR (Task 7)

