/**
 * The Markdown link reader and the token flattener, on their own.
 *
 * Both decide what "an internal link" means, so both are pinned on the cases
 * that would otherwise turn a false positive into a failed handoff: a link
 * inside a fenced block, a path inside backticks, a title after the target.
 */

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULT_LIMITS, classifyTarget, extractLinks, flattenTokens, resolveNoteTarget } from '../src/index.mjs'

const NEWLINE = String.fromCharCode(10)
const lines = (...rows) => rows.join(NEWLINE) + NEWLINE

describe('extractLinks', () => {
  test('finds an inline link and reports the line it is on', () => {
    const { links } = extractLinks(lines('# Title', '', 'see [a](./a.md)'), 100)
    assert.deepEqual(links, [{ target: './a.md', line: 3, image: false }])
  })

  test('finds an inline image and says it is one', () => {
    const { links } = extractLinks(lines('![alt](./a.png)'), 100)
    assert.deepEqual(links, [{ target: './a.png', line: 1, image: true }])
  })

  test('skips a title after the target', () => {
    const { links } = extractLinks(lines('[a](./a.md "A title with (parens)")'), 100)
    assert.deepEqual(links.map((link) => link.target), ['./a.md'])
  })

  test('unwraps an angle-bracketed target', () => {
    const { links } = extractLinks(lines('[a](<./a b.md>)'), 100)
    assert.deepEqual(links.map((link) => link.target), ['./a b.md'])
  })

  test('ignores a link inside a fenced code block', () => {
    const { links } = extractLinks(lines('```', '[a](./a.md)', '```', '[b](./b.md)'), 100)
    assert.deepEqual(links.map((link) => link.target), ['./b.md'])
  })

  test('ignores a link inside a tilde fence', () => {
    const { links } = extractLinks(lines('~~~', '[a](./a.md)', '~~~'), 100)
    assert.deepEqual(links, [])
  })

  test('does not let a tilde fence close a backtick fence', () => {
    const { links } = extractLinks(lines('```', '~~~', '[a](./a.md)', '```', '[b](./b.md)'), 100)
    assert.deepEqual(links.map((link) => link.target), ['./b.md'])
  })

  test('ignores a path inside an inline code span', () => {
    const { links } = extractLinks(lines('use `[a](./a.md)` here'), 100)
    assert.deepEqual(links, [])
  })

  test('finds two links on one line', () => {
    const { links } = extractLinks(lines('[a](./a.md) and [b](./b.md)'), 100)
    assert.deepEqual(links.map((link) => link.target), ['./a.md', './b.md'])
  })

  test('stops at the limit and says so, rather than reporting a shorter answer', () => {
    const { links, truncated } = extractLinks(lines('[a](./a.md) [b](./b.md) [c](./c.md)'), 2)
    assert.equal(links.length, 2)
    assert.equal(truncated, true)
  })

  test('handles every line ending', () => {
    const CR = String.fromCharCode(13)
    const { links } = extractLinks('[a](./a.md)' + CR + NEWLINE + '[b](./b.md)' + CR + '[c](./c.md)', 100)
    assert.deepEqual(links.map((link) => link.line), [1, 2, 3])
  })
})

describe('classifyTarget', () => {
  const cases = [
    ['./a.md', 'relative'],
    ['a.md', 'relative'],
    ['../a.md', 'relative'],
    ['#states', 'fragment'],
    ['https://example.invalid/', 'external'],
    ['mailto:someone@example.invalid', 'external'],
    ['//example.invalid/a', 'external'],
    ['', 'empty'],
  ]
  for (const [target, expected] of cases) {
    test(JSON.stringify(target) + ' is ' + expected, () => {
      assert.equal(classifyTarget(target), expected)
    })
  }
})

describe('resolveNoteTarget', () => {
  test('resolves against the note, not the root', () => {
    assert.deepEqual(resolveNoteTarget('notes/button.md', './anatomy.md'), { ok: true, path: 'notes/anatomy.md' })
    assert.deepEqual(resolveNoteTarget('notes/button.md', '../contracts/b.json'), { ok: true, path: 'contracts/b.json' })
  })

  test('drops a fragment and a query before resolving', () => {
    assert.deepEqual(resolveNoteTarget('notes/b.md', './a.md#states'), { ok: true, path: 'notes/a.md' })
    assert.deepEqual(resolveNoteTarget('notes/b.md', './a.md?v=2'), { ok: true, path: 'notes/a.md' })
  })

  test('decodes percent escapes, because a renderer does', () => {
    assert.deepEqual(resolveNoteTarget('notes/b.md', './a%20b.md'), { ok: true, path: 'notes/a b.md' })
  })

  test('refuses a target that climbs out of the root', () => {
    assert.equal(resolveNoteTarget('notes/b.md', '../../etc/passwd').ok, false)
    assert.equal(resolveNoteTarget('notes/b.md', '../../etc/passwd').reason, 'escapes-root')
  })

  test('refuses an absolute target and a backslash target', () => {
    assert.equal(resolveNoteTarget('notes/b.md', '/etc/passwd').reason, 'absolute')
    assert.equal(resolveNoteTarget('notes/b.md', '.\\a.md').reason, 'backslash')
  })

  test('refuses a target whose escapes do not decode', () => {
    assert.equal(resolveNoteTarget('notes/b.md', './a%ZZ.md').reason, 'undecodable')
  })

  test('refuses a target that resolves to the directory itself', () => {
    assert.equal(resolveNoteTarget('button.md', './').ok, false)
  })
})

describe('flattenTokens', () => {
  const limits = DEFAULT_LIMITS

  test('names a leaf by its dotted path, in either spelling', () => {
    const { names } = flattenTokens({
      color: { brand: { primary: { $value: '#1' } }, surface: { raised: { value: '#2' } } },
    }, limits)
    assert.deepEqual(names, ['color.brand.primary', 'color.surface.raised'])
  })

  test('ignores keys that start with a dollar sign', () => {
    const { names } = flattenTokens({ color: { $type: 'color', a: { $value: '#1' } } }, limits)
    assert.deepEqual(names, ['color.a'])
  })

  test('reports a key no dotted citation could name, and does not invent one', () => {
    const { names, rejected } = flattenTokens({ color: { 'a.b': { $value: '#1' }, c: { $value: '#2' } } }, limits)
    assert.deepEqual(names, ['color.c'])
    assert.deepEqual(rejected, ['color.a.b'])
  })

  test('stops at the name limit and says so', () => {
    const { names, truncated } = flattenTokens(
      { a: { $value: 1 }, b: { $value: 2 }, c: { $value: 3 } },
      { ...limits, maxTokensPerDocument: 2 },
    )
    assert.equal(names.length, 2)
    assert.equal(truncated, true)
  })

  test('stops at the depth limit and says so', () => {
    const { tooDeep } = flattenTokens({ a: { b: { c: { $value: 1 } } } }, { ...limits, maxTokenDepth: 2 })
    assert.equal(tooDeep, true)
  })

  test('returns nothing for a document that is not an object', () => {
    assert.deepEqual(flattenTokens([], limits).names, [])
    assert.deepEqual(flattenTokens('text', limits).names, [])
  })

  test('does not treat the document root as a token even when it looks like one', () => {
    assert.deepEqual(flattenTokens({ $value: '#1' }, limits).names, [])
  })
})
