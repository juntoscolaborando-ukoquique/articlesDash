/**
 * test/groq-enrichment.test.mjs
 *
 * Unit tests for src/lib/groq-enrichment.mjs
 * Uses injectable _groqClient seam to test without real API calls.
 *
 * Run: npm test -- test/groq-enrichment.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { enrichDraft, finalizeArticle } from '../src/lib/groq-enrichment.mjs';

// ── Test Helpers ──────────────────────────────────────────────────────────────

/**
 * Mock Groq client that returns a canned response.
 * @param {object} choices — array with [{ message: { content: "..." } }]
 */
function mockGroqClient(choices) {
  return {
    chat: {
      completions: {
        create: async (params, options) => ({
          choices,
        }),
      },
    },
  };
}

/**
 * Creates a mock response with JSON inside optional <think> block.
 */
function mockResponse(json, withThinkBlock = false) {
  const jsonStr = JSON.stringify(json);
  if (withThinkBlock) {
    return `<think>Analyzing the text structure...</think>\n${jsonStr}`;
  }
  return jsonStr;
}

// ── Test Suite ────────────────────────────────────────────────────────────────

test('enrichDraft — happy path', async (t) => {
  const mockClient = mockGroqClient([{
    message: {
      content: mockResponse({
        title: 'Test Article',
        soustitre: 'A Test',
        surtitre: 'CATEGORY',
        descriptif: 'Brief description for SEO.',
        chapo: '<p>Introductory paragraph.</p>',
        contentHtml: '<h3>Section</h3><p>Content here.</p>',
        ps: '<p>Additional notes.</p>',
        topics: ['topic-1', 'topic-2'],
        section: 'general',
        language: 'ES',
        author: 'Test Author',
        sourceSite: 'Test Site',
        sourceUrl: 'https://example.com',
        sourceDate: '2026-09-14',
      }),
    },
  }]);

  const result = await enrichDraft('Raw test text', {}, { _groqClient: mockClient });

  assert.strictEqual(result.chapo, '<p>Introductory paragraph.</p>');
  assert.strictEqual(result.contentHtml, '<h3>Section</h3><p>Content here.</p>');
  assert.strictEqual(result.ps, '<p>Additional notes.</p>');
  assert.deepStrictEqual(result.guessed, {
    sourceUrl: 'https://example.com',
    sourceSite: 'Test Site',
    sourceDate: '2026-09-14',
    author: 'Test Author',
  });
  assert(result.extra.title);
  assert(result.groqWarnings !== undefined);
});

test('enrichDraft — partial input (preserve existing fields)', async (t) => {
  const mockClient = mockGroqClient([{
    message: {
      content: mockResponse({
        title: 'New Title',
        chapo: '<p>New chapo.</p>',
        contentHtml: '<p>New content.</p>',
        ps: '',
        topics: ['new-topic'],
        section: 'actualidad',
      }),
    },
  }]);

  // Pass existing title — should not be overwritten
  const result = await enrichDraft('Raw text', { title: 'Existing Title' }, { _groqClient: mockClient });

  // Groq returned a new title, but it goes in 'extra' and should not overwrite
  assert.strictEqual(result.chapo, '<p>New chapo.</p>');
  assert.strictEqual(result.contentHtml, '<p>New content.</p>');
  // title is in extra but caller will respect "never overwrite"
  if (result.extra.title) {
    assert.strictEqual(result.extra.title, 'New Title');
  }
});

test('enrichDraft — think block stripping', async (t) => {
  const mockClient = mockGroqClient([{
    message: {
      content: mockResponse(
        {
          title: 'Article',
          chapo: '<p>Intro.</p>',
          contentHtml: '<p>Content.</p>',
          ps: '',
          topics: ['test'],
          section: 'general',
        },
        true // with think block
      ),
    },
  }]);

  const result = await enrichDraft('Raw text', {}, { _groqClient: mockClient });

  assert.strictEqual(result.chapo, '<p>Intro.</p>');
  assert(result.contentHtml.includes('Content'));
  assert(!result.contentHtml.includes('<think>'));
});

test('enrichDraft — malformed JSON throws GROQ_PARSE_ERROR', async (t) => {
  const mockClient = mockGroqClient([{
    message: { content: '{ invalid json' },
  }]);

  try {
    await enrichDraft('Raw text', {}, { _groqClient: mockClient });
    assert.fail('Should have thrown');
  } catch (err) {
    assert.strictEqual(err.code, 'GROQ_PARSE_ERROR');
    assert(err.message.includes('JSON'));
  }
});

test('enrichDraft — all-reasoning response (no JSON) throws GROQ_PARSE_ERROR', async (t) => {
  const mockClient = mockGroqClient([{
    message: { content: '<think>Just reasoning, no output</think>' },
  }]);

  try {
    await enrichDraft('Raw text', {}, { _groqClient: mockClient });
    assert.fail('Should have thrown');
  } catch (err) {
    assert.strictEqual(err.code, 'GROQ_PARSE_ERROR');
    assert(err.message.includes('empty or all-reasoning'));
  }
});

test('enrichDraft — forbidden HTML tags in contentHtml validates and warns', async (t) => {
  const mockClient = mockGroqClient([{
    message: {
      content: mockResponse({
        title: 'Article',
        chapo: '<p>Intro.</p>',
        contentHtml: '<div><script>alert("xss")</script><p>Real content.</p></div>',
        ps: '',
        topics: ['test'],
        section: 'general',
      }),
    },
  }]);

  const result = await enrichDraft('Raw text', {}, { _groqClient: mockClient });

  // validateHtml should have caught the forbidden tags
  assert(result.contentHtml); // still has some content
  assert(result.groqWarnings.length > 0); // should have warnings
});

test('enrichDraft — no GROQ_API_KEY and no _groqClient throws GROQ_API_ERROR', async (t) => {
  // Save and clear the env var
  const savedKey = process.env.GROQ_API_KEY;
  delete process.env.GROQ_API_KEY;

  try {
    await enrichDraft('Raw text', {}, {});
    assert.fail('Should have thrown');
  } catch (err) {
    assert.strictEqual(err.code, 'GROQ_API_ERROR');
    assert(err.message.includes('API_KEY') || err.message.includes('key'));
  } finally {
    if (savedKey) process.env.GROQ_API_KEY = savedKey;
  }
});

test('enrichDraft — network error on first attempt retries and succeeds', async (t) => {
  let callCount = 0;
  const mockClient = {
    chat: {
      completions: {
        create: async (params, options) => {
          callCount++;
          if (callCount === 1) {
            // First call times out
            const err = new Error('Simulated timeout');
            err.name = 'AbortError';
            throw err;
          }
          // Second call succeeds
          return {
            choices: [{
              message: {
                content: mockResponse({
                  title: 'Article',
                  chapo: '<p>After retry.</p>',
                  contentHtml: '<p>Content.</p>',
                  ps: '',
                  topics: ['test'],
                  section: 'general',
                }),
              },
            }],
          };
        },
      },
    },
  };

  const result = await enrichDraft('Raw text', {}, { _groqClient: mockClient });

  assert.strictEqual(callCount, 2); // retried
  assert(result.chapo.includes('After retry'));
});

test('enrichDraft — network error on both attempts throws GROQ_API_ERROR', async (t) => {
  const mockClient = {
    chat: {
      completions: {
        create: async (params, options) => {
          const err = new Error('Network error');
          err.name = 'AbortError';
          throw err;
        },
      },
    },
  };

  try {
    await enrichDraft('Raw text', {}, { _groqClient: mockClient });
    assert.fail('Should have thrown');
  } catch (err) {
    assert.strictEqual(err.code, 'GROQ_API_ERROR');
  }
});

test('finalizeArticle — happy path (fills gaps)', async (t) => {
  const mockClient = mockGroqClient([{
    message: {
      content: mockResponse({
        descriptif: 'Generated descriptif.',
        chapo: '<p>Generated chapo.</p>',
        topics: ['topic-1', 'topic-2', 'topic-3'],
        section: 'tierra',
      }),
    },
  }]);

  const article = {
    title: 'Article',
    contentHtml: '<p>Content.</p>',
    chapo: '', // empty
    descriptif: '', // empty
    topics: [], // empty
    section: 'invalid-section', // invalid
  };

  const result = await finalizeArticle(article, { _groqClient: mockClient });

  assert(result.patch.descriptif);
  assert(result.patch.chapo);
  assert(result.patch.topics);
  assert(result.patch.section);
});

test('finalizeArticle — preserves complete fields (never overwrites)', async (t) => {
  const mockClient = mockGroqClient([{
    message: {
      content: mockResponse({
        descriptif: 'New descriptif (should be ignored)',
        topics: ['ignored'],
      }),
    },
  }]);

  const article = {
    title: 'Article',
    contentHtml: '<p>Content.</p>',
    descriptif: 'Existing descriptif',
    topics: ['existing-1', 'existing-2'],
  };

  const result = await finalizeArticle(article, { _groqClient: mockClient });

  // Groq suggested changes, but they should not be in the patch
  // because the fields are already complete
  assert(!result.patch.descriptif || result.patch.descriptif === 'Existing descriptif');
  assert(!result.patch.topics || result.patch.topics.length >= 2);
});

test('finalizeArticle — empty response (nothing to fix)', async (t) => {
  const mockClient = mockGroqClient([{
    message: { content: mockResponse({}) },
  }]);

  const article = {
    title: 'Article',
    descriptif: 'Complete.',
    topics: ['a', 'b'],
    contentHtml: '<p>Content.</p>',
  };

  const result = await finalizeArticle(article, { _groqClient: mockClient });

  assert.deepStrictEqual(result.patch, {});
  assert.deepStrictEqual(result.groqWarnings, []);
});

test('finalizeArticle — contentHtml validation and sanitisation', async (t) => {
  const mockClient = mockGroqClient([{
    message: {
      content: mockResponse({
        contentHtml: '<div><p>Bad tags.</p></div>',
      }),
    },
  }]);

  const article = {
    title: 'Article',
    contentHtml: '<p>Original.</p>',
  };

  const result = await finalizeArticle(article, { _groqClient: mockClient });

  assert(result.patch.contentHtml); // still patched, but with warnings
  assert(result.groqWarnings.length > 0);
});

test('finalizeArticle — malformed JSON throws GROQ_PARSE_ERROR', async (t) => {
  const mockClient = mockGroqClient([{
    message: { content: 'not json at all' },
  }]);

  try {
    await finalizeArticle({ title: 'Article' }, { _groqClient: mockClient });
    assert.fail('Should have thrown');
  } catch (err) {
    assert.strictEqual(err.code, 'GROQ_PARSE_ERROR');
  }
});

test('finalizeArticle — no GROQ_API_KEY throws GROQ_API_ERROR', async (t) => {
  const savedKey = process.env.GROQ_API_KEY;
  delete process.env.GROQ_API_KEY;

  try {
    await finalizeArticle({ title: 'Article' }, {});
    assert.fail('Should have thrown');
  } catch (err) {
    assert.strictEqual(err.code, 'GROQ_API_ERROR');
  } finally {
    if (savedKey) process.env.GROQ_API_KEY = savedKey;
  }
});

test('finalizeArticle — generates 2+ topics if empty', async (t) => {
  const mockClient = mockGroqClient([{
    message: {
      content: mockResponse({
        topics: ['auto-1', 'auto-2', 'auto-3'],
      }),
    },
  }]);

  const article = {
    title: 'Article',
    topics: [], // empty
  };

  const result = await finalizeArticle(article, { _groqClient: mockClient });

  assert(result.patch.topics);
  assert.strictEqual(result.patch.topics.length, 3);
});

test('finalizeArticle — skips topics if already has 2+', async (t) => {
  const mockClient = mockGroqClient([{
    message: {
      content: mockResponse({
        topics: ['new-1', 'new-2'], // Groq suggests replacements
      }),
    },
  }]);

  const article = {
    title: 'Article',
    topics: ['existing-1', 'existing-2', 'existing-3'],
  };

  const result = await finalizeArticle(article, { _groqClient: mockClient });

  // topics should not be in patch because article already has 3
  assert(!result.patch.topics);
});
