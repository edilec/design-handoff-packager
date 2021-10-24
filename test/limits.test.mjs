/**
 * Limits: enforced, documented, and impossible to mistype into silence.
 *
 * A documented limit the CLI never wired through has already turned a real
 * failure into a green run in this catalog, so every default is asserted
 * against the README table and every override is driven through the CLI in
 * `severity-behaviour.test.mjs`.
 */

import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import { DEFAULT_LIMITS, auditHandoff, flattenTokens, validateLimits } from '../src/index.mjs'
import { cleanup, json, planFor, scratch, treeFor, writeTree } from './support.mjs'

after(cleanup)

describe('the limit table', () => {
  test('is frozen', () => {
    assert.ok(Object.isFrozen(DEFAULT_LIMITS))
  })

  test('documents every limit in the README with its default', async () => {
    const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8')
    for (const [name, value] of Object.entries(DEFAULT_LIMITS)) {
      const row = new RegExp('\\| `' + name + '` \\| ' + value + ' \\|')
      assert.match(readme, row, name + ' is missing from the README limit table, or its default disagrees')
    }
  })

  test('documents no limit the code does not have', async () => {
    const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8')
    const documented = [...readme.matchAll(/^\| `(max[A-Za-z]+)` \| (\d+) \|/gm)].map((found) => found[1])
    assert.ok(documented.length >= 8, 'the README parser found ' + documented.length + ' rows')
    for (const name of documented) {
      assert.ok(Object.hasOwn(DEFAULT_LIMITS, name), name + ' is documented but does not exist')
    }
  })
})

describe('validateLimits', () => {
  test('returns the defaults when given nothing', () => {
    assert.deepEqual({ ...validateLimits() }, { ...DEFAULT_LIMITS })
  })

  test('applies one override without disturbing the rest', () => {
    const limits = validateLimits({ maxFiles: 7 })
    assert.equal(limits.maxFiles, 7)
    assert.equal(limits.maxComponents, DEFAULT_LIMITS.maxComponents)
  })

  test('refuses an unknown name rather than ignoring it', () => {
    assert.throws(() => validateLimits({ maxFile: 7 }), /Unknown limit "maxFile"/)
  })

  test('refuses a value that is not a positive integer', () => {
    for (const value of [0, -1, 1.5, '4', null, Number.NaN, Infinity]) {
      assert.throws(() => validateLimits({ maxFiles: value }), TypeError, String(value))
    }
  })

  test('refuses a non-object', () => {
    assert.throws(() => validateLimits([]), TypeError)
    assert.throws(() => validateLimits('maxFiles=4'), TypeError)
  })
})

describe('options', () => {
  test('an unknown option name is refused rather than ignored', async () => {
    const root = await writeTree(await scratch(), treeFor())
    await assert.rejects(() => auditHandoff({ root, verbose: true }), /Unknown option "verbose"/)
  })

  test('a missing root is refused', async () => {
    await assert.rejects(() => auditHandoff({}), TypeError)
    await assert.rejects(() => auditHandoff({ root: '   ' }), TypeError)
  })
})

describe('a bounded evidence sample does not become the count', () => {
  test('a document with more uncitable keys than the sample holds reports all of them', () => {
    const document = { color: {} }
    for (let index = 0; index < 15; index += 1) document.color[`bad key ${index}`] = { $value: '#000000' }
    const flattened = flattenTokens(document, DEFAULT_LIMITS)
    assert.equal(flattened.rejectedCount, 15, 'the count is what was found, not what the sample holds')
    assert.equal(flattened.rejected.length, 10, 'the sample stays bounded: it reaches the report')
  })

  test('and the finding says the number it found', async () => {
    const document = { color: {} }
    for (let index = 0; index < 15; index += 1) document.color[`bad key ${index}`] = { $value: '#000000' }
    const base = planFor()
    const root = await writeTree(await scratch(), treeFor(planFor({
      components: [{ ...base.components[0], tokensUsed: [] }],
    }), { 'tokens/color.json': json(document) }))
    const report = await auditHandoff({ root })
    const finding = report.findings.find((entry) => entry.ruleId === 'token-name-unusable')
    assert.match(finding.message, /declares 15 group or token key\(s\)/)
  })
})
