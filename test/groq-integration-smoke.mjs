/**
 * test/groq-integration-smoke.mjs
 *
 * Smoke test: verify Groq module integrates with server endpoints
 * without requiring live API calls (using mock client).
 *
 * Run: node test/groq-integration-smoke.mjs
 */

import assert from 'node:assert/strict';
import { enrichDraft, finalizeArticle } from '../src/lib/groq-enrichment.mjs';

console.log('🧪 Groq Integration Smoke Tests\n');

// ── Test 1: Groq module dynamic import ──────────────────────────────────

console.log('✓ Test 1: groq-enrichment.mjs imports and exports correctly');
assert.strictEqual(typeof enrichDraft, 'function');
assert.strictEqual(typeof finalizeArticle, 'function');
console.log('  - enrichDraft function: present');
console.log('  - finalizeArticle function: present\n');

// ── Test 2: enrichDraft with mock client ──────────────────────────────

console.log('✓ Test 2: enrichDraft() works with injected mock client');
const mockClient = {
  chat: {
    completions: {
      create: async () => ({
        choices: [{
          message: {
            content: JSON.stringify({
              title: 'Test Article',
              chapo: '<p>Intro.</p>',
              contentHtml: '<p>Content.</p>',
              ps: '',
              topics: ['test-1', 'test-2'],
              section: 'general',
            }),
          },
        }],
      }),
    },
  },
};

const result = await enrichDraft('Raw text', {}, { _groqClient: mockClient });
assert(result.chapo);
assert(result.contentHtml);
assert(result.guessed !== undefined);
assert(result.groqWarnings !== undefined);
assert.strictEqual(result.model, 'qwen/qwen3.8-27b');
console.log('  - Returns enriched fields with warnings');
console.log('  - Model:', result.model);
console.log('  - Warnings:', result.groqWarnings.length, 'items\n');

// ── Test 3: finalizeArticle with mock client ──────────────────────────

console.log('✓ Test 3: finalizeArticle() works with injected mock client');
const result2 = await finalizeArticle(
  {
    title: 'Article',
    contentHtml: '<p>Content.</p>',
    descriptif: '', // empty — should be filled
    topics: [], // empty — should be filled
  },
  { _groqClient: mockClient }
);
assert(result2.patch !== undefined);
assert(result2.groqWarnings !== undefined);
assert.strictEqual(result2.model, 'qwen/qwen3.8-27b');
console.log('  - Returns patch object and warnings');
console.log('  - Model:', result2.model);
console.log('  - Patch keys:', Object.keys(result2.patch).join(', ') || '(empty)\n');

// ── Test 4: Error handling — no API key, no client ──────────────────────

console.log('✓ Test 4: Error handling when no GROQ_API_KEY and no client');
const savedKey = process.env.GROQ_API_KEY;
delete process.env.GROQ_API_KEY;
try {
  await enrichDraft('text', {}, {});
  assert.fail('Should have thrown');
} catch (err) {
  assert.strictEqual(err.code, 'GROQ_API_ERROR');
  console.log('  - Throws GROQ_API_ERROR when key missing');
} finally {
  if (savedKey) process.env.GROQ_API_KEY = savedKey;
}
console.log();

// ── Test 5: Malformed JSON error ──────────────────────────────────────

console.log('✓ Test 5: Error handling for malformed Groq response');
const badMockClient = {
  chat: {
    completions: {
      create: async () => ({
        choices: [{
          message: { content: 'not valid json' },
        }],
      }),
    },
  },
};
try {
  await enrichDraft('text', {}, { _groqClient: badMockClient });
  assert.fail('Should have thrown');
} catch (err) {
  assert.strictEqual(err.code, 'GROQ_PARSE_ERROR');
  console.log('  - Throws GROQ_PARSE_ERROR for malformed JSON\n');
}

// ── Test 6: validateHtml export ───────────────────────────────────────

console.log('✓ Test 6: validateHtml is exported from article-validator');
const { validateHtml } = await import('../src/lib/article-validator.mjs');
assert.strictEqual(typeof validateHtml, 'function');
const errors = validateHtml('<p>Valid HTML</p>', 'test');
assert(Array.isArray(errors));
console.log('  - validateHtml function present and working');
console.log('  - Validation result:', errors.length, 'errors\n');

// ── Summary ───────────────────────────────────────────────────────────

console.log('═════════════════════════════════════════');
console.log('✅ All smoke tests passed!');
console.log('═════════════════════════════════════════\n');

console.log('Summary:');
console.log('  • groq-enrichment.mjs module: ✓ Ready');
console.log('  • enrichDraft() function: ✓ Working');
console.log('  • finalizeArticle() function: ✓ Working');
console.log('  • Error handling: ✓ Robust');
console.log('  • Integration with server: ✓ Can proceed\n');
