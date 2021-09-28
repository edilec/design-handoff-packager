/**
 * Severity, pinned on what a run of the tool DOES.
 *
 * A table asserted against a document is three declarations agreeing with each
 * other, and a coordinated edit of all three passes: one tool in this catalog
 * had 40 of 52 error rules survive exactly that flip. So every rule below is
 * driven through the real command line entry point and the observable outcome
 * is asserted -- the exit code, and which stream carried the report.
 *
 *   policy + error   -> exit 1, status "fail",       report on stdout
 *   evidence + error -> exit 2, status "incomplete",  report on stdout
 *   info             -> exit 0, status "pass",        report on stdout
 *
 * Flipping any of these rules down to `warning` moves an exit code, and an
 * exit code cannot be edited into agreement with anything.
 */

import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { chmod, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { RULE_OUTCOME, RULE_SEVERITY } from '../src/index.mjs'
import { cleanup, json, planFor, reportFrom, runCli, scratch, treeFor, writeTree } from './support.mjs'

after(cleanup)

const NEWLINE = String.fromCharCode(10)
const INVALID_UTF8 = Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0xfe, 0x22, 0x7d])
const base = planFor()

function withComponent(overrides) {
  return planFor({ components: [{ ...base.components[0], ...overrides }] })
}

/** Each case builds a tree and extra arguments; the rule must then fire. */
const CASES = [
  {
    rule: 'cross-reference-unresolved',
    tree: () => treeFor(withComponent({ seeAlso: ['split-button'] })),
  },
  {
    rule: 'duplicate-component-id',
    tree: () => treeFor(planFor({ components: [base.components[0], base.components[0]] })),
  },
  {
    rule: 'duplicate-state',
    tree: () => treeFor(withComponent({
      states: [...base.components[0].states, base.components[0].states[0]],
    })),
  },
  {
    // `tokensUsed` is emptied on purpose: a duplicate id also stops the token
    // set being complete, which raises an `evidence` finding and would move
    // the exit code to 2. This case is here to pin THIS rule's exit code, so
    // it is the only rule the run fires.
    rule: 'duplicate-token-document-id',
    tree: () => treeFor(planFor({
      tokens: [{ id: 'color', source: 'tokens/color.json' }, { id: 'color', source: 'tokens/space.json' }],
      components: [{ ...base.components[0], tokensUsed: [] }],
    }), { 'tokens/space.json': json({ space: { small: { $value: '4px' } } }) }),
  },
  {
    rule: 'id-case-collision',
    tree: () => treeFor(planFor({
      components: [base.components[0], { ...base.components[0], id: 'Button' }],
    })),
  },
  { rule: 'no-components', tree: () => ({ 'handoff.json': json(planFor({ components: [] })) }) },
  {
    rule: 'note-link-unresolved',
    tree: () => treeFor(planFor(), { 'notes/button.md': '[x](./nowhere.md)' + NEWLINE }),
  },
  { rule: 'plan-schema-invalid', tree: () => treeFor(planFor({ schemaVersion: '2' })) },
  { rule: 'source-missing', tree: () => treeFor(withComponent({ contract: 'contracts/nope.json' })) },
  {
    rule: 'source-not-a-file',
    tree: () => treeFor(withComponent({ contract: 'contracts/adir' })),
    after: async (root) => mkdir(resolve(root, 'contracts/adir')),
  },
  {
    rule: 'state-evidence-missing',
    tree: () => treeFor(withComponent({ states: [base.components[0].states[0]] })),
  },
  {
    rule: 'state-evidence-stale',
    tree: () => treeFor(planFor({
      evidenceMaxAgeDays: 30,
      components: [{
        ...base.components[0],
        states: base.components[0].states.map((state) => ({ ...state, capturedAt: '2020-01-01T00:00:00Z' })),
      }],
    })),
    args: ['--now', '2026-01-01T00:00:00Z'],
  },
  {
    rule: 'state-evidence-undated',
    tree: () => treeFor(planFor({ evidenceMaxAgeDays: 30 })),
    args: ['--now', '2026-01-01T00:00:00Z'],
  },
  { rule: 'story-link-unresolved', tree: () => treeFor(withComponent({ story: 'stories/button.md' })) },
  {
    rule: 'token-name-unusable',
    tree: () => treeFor(planFor(), {
      'tokens/color.json': json({ color: { brand: { primary: { $value: '#1' } }, 'a.b': { $value: '#2' } } }),
    }),
  },
  { rule: 'token-reference-unresolved', tree: () => treeFor(withComponent({ tokensUsed: ['color.nope'] })) },

  // --- evidence ------------------------------------------------------
  {
    rule: 'note-links-truncated',
    tree: () => treeFor(planFor(), {
      'notes/button.md': '[a](./a.md) [b](./b.md)' + NEWLINE,
      'notes/a.md': 'a' + NEWLINE,
      'notes/b.md': 'b' + NEWLINE,
    }),
    args: ['--limit', 'maxNoteLinks=1'],
  },
  { rule: 'package-too-large', tree: () => treeFor(), args: ['--limit', 'maxPackageBytes=1'] },
  { rule: 'plan-invalid-json', tree: () => ({ 'handoff.json': '{ not json' }) },
  { rule: 'plan-not-utf8', tree: () => ({ 'handoff.json': INVALID_UTF8 }) },
  { rule: 'plan-too-large', tree: () => treeFor(), args: ['--limit', 'maxPlanBytes=10'] },
  { rule: 'plan-unreadable', tree: () => ({ 'other.json': '{}' }) },
  { rule: 'source-invalid-json', tree: () => treeFor(planFor(), { 'contracts/button.json': '{ nope' }) },
  { rule: 'source-not-utf8', tree: () => treeFor(planFor(), { 'contracts/button.json': INVALID_UTF8 }) },
  { rule: 'source-too-large', tree: () => treeFor(), args: ['--limit', 'maxFileBytes=1'] },
  {
    rule: 'token-document-too-deep',
    tree: () => treeFor(),
    args: ['--limit', 'maxTokenDepth=1'],
  },
  {
    rule: 'token-document-truncated',
    tree: () => treeFor(planFor(), {
      'tokens/color.json': json({ color: { brand: { primary: { $value: '#1' }, secondary: { $value: '#2' } } } }),
    }),
    args: ['--limit', 'maxTokensPerDocument=1'],
  },
  {
    rule: 'token-references-unchecked',
    tree: () => treeFor(planFor({ tokens: [{ id: 'color', source: 'tokens/nope.json' }] })),
  },
  {
    rule: 'too-many-components',
    tree: () => treeFor(planFor({
      components: [base.components[0], { ...base.components[0], id: 'other' }],
    })),
    args: ['--limit', 'maxComponents=1'],
  },
  { rule: 'too-many-files', tree: () => treeFor(), args: ['--limit', 'maxFiles=1'] },
  { rule: 'too-many-states', tree: () => treeFor(), args: ['--limit', 'maxStatesPerComponent=1'] },
  {
    rule: 'too-many-token-documents',
    tree: () => treeFor(planFor({
      tokens: [{ id: 'color', source: 'tokens/color.json' }, { id: 'space', source: 'tokens/color.json' }],
    })),
    args: ['--limit', 'maxTokenDocuments=1'],
  },

  // --- info ----------------------------------------------------------
  {
    rule: 'note-link-external',
    tree: () => treeFor(planFor(), { 'notes/button.md': '[x](https://example.invalid/)' + NEWLINE }),
  },
  { rule: 'story-link-external', tree: () => treeFor(withComponent({ story: 'https://example.invalid/s' })) },
]

const EXPECTED = { policy: { code: 1, status: 'fail' }, evidence: { code: 2, status: 'incomplete' } }

const exercised = new Set()

describe('every rule decides the exit code it is documented to decide', () => {
  for (const testCase of CASES) {
    exercised.add(testCase.rule)
    test(testCase.rule, async () => {
      const root = await writeTree(await scratch(), testCase.tree())
      if (testCase.after) await testCase.after(root)
      const result = runCli(['--root', root, '--json', ...(testCase.args ?? [])])
      const report = reportFrom(result)
      assert.ok(
        report.findings.some((finding) => finding.ruleId === testCase.rule),
        'expected ' + testCase.rule + ', got: ' + report.findings.map((f) => f.ruleId).join(', '),
      )
      if (RULE_SEVERITY[testCase.rule] === 'info') {
        assert.equal(result.code, 0)
        assert.equal(report.status, 'pass')
        return
      }
      const expected = EXPECTED[RULE_OUTCOME[testCase.rule]]
      assert.equal(result.code, expected.code, testCase.rule + ' must exit ' + expected.code)
      assert.equal(report.status, expected.status)
    })
  }

  test('root-unreadable', async () => {
    exercised.add('root-unreadable')
    const result = runCli(['--root', resolve(await scratch(), 'nowhere'), '--json'])
    const report = reportFrom(result)
    assert.equal(result.code, 2)
    assert.equal(report.status, 'incomplete')
    assert.deepEqual(report.findings.map((finding) => finding.ruleId), ['root-unreadable'])
  })

  test('source-escapes-root', async () => {
    exercised.add('source-escapes-root')
    const outside = await scratch()
    await writeFile(resolve(outside, 'elsewhere.json'), json({ name: 'Button' }))
    const root = await writeTree(await scratch(), treeFor())
    await rm(resolve(root, 'contracts/button.json'))
    await symlink(resolve(outside, 'elsewhere.json'), resolve(root, 'contracts/button.json'), 'file')
    const result = runCli(['--root', root, '--json'])
    const report = reportFrom(result)
    assert.equal(result.code, 1)
    assert.equal(report.status, 'fail')
    assert.ok(report.findings.some((finding) => finding.ruleId === 'source-escapes-root'))
  })

  test('source-unreadable', async (t) => {
    exercised.add('source-unreadable')
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      t.skip('root can read a mode-000 file, so the fixture cannot be built')
      return
    }
    const root = await writeTree(await scratch(), treeFor())
    await chmod(resolve(root, 'contracts/button.json'), 0o000)
    const result = runCli(['--root', root, '--json'])
    await chmod(resolve(root, 'contracts/button.json'), 0o644)
    const report = reportFrom(result)
    assert.equal(result.code, 2, 'an unreadable file is incomplete, never absent')
    assert.equal(report.status, 'incomplete')
    assert.ok(report.findings.some((finding) => finding.ruleId === 'source-unreadable'))
    assert.ok(!report.findings.some((finding) => finding.ruleId === 'source-missing'))
  })

  test('source-unreadable, when it is the DIRECTORY that cannot be entered', async (t) => {
    // A different code path from the unreadable file above: the failure lands
    // on realpath rather than on the read, and it must still be incomplete
    // rather than absent. Guarding one of the two and not the other is how an
    // unreadable input gets reported as a missing one.
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      t.skip('root can enter a mode-000 directory, so the fixture cannot be built')
      return
    }
    const root = await writeTree(await scratch(), treeFor())
    await chmod(resolve(root, 'contracts'), 0o000)
    const result = runCli(['--root', root, '--json'])
    await chmod(resolve(root, 'contracts'), 0o755)
    const report = reportFrom(result)
    assert.equal(result.code, 2)
    assert.equal(report.status, 'incomplete')
    assert.ok(report.findings.some((finding) => finding.ruleId === 'source-unreadable'))
    assert.ok(!report.findings.some((finding) => finding.ruleId === 'source-missing'),
      'a directory that cannot be entered is not evidence that the file is gone')
  })
})

describe('the behavioural coverage of the rule catalog', () => {
  test('every documented rule is exercised by a real run above', () => {
    const missing = Object.keys(RULE_SEVERITY).filter((ruleId) => !exercised.has(ruleId))
    assert.deepEqual(missing, [], 'these rules decide an exit code that nothing pins: ' + missing.join(', '))
  })
})
