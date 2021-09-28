/**
 * The acceptance criteria, item by item.
 *
 * "All internal links resolve; missing required state evidence fails; paths
 * are relative and reproducible across machines." The third is in
 * `reproducibility.test.mjs` because it needs two trees in two places.
 */

import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { auditHandoff, inspectHandoff } from '../src/index.mjs'
import { cleanup, fixture, json, planFor, reportFrom, ruleIds, runCli, scratch, treeFor, writeTree } from './support.mjs'

after(cleanup)

describe('a plan whose every internal link resolves', () => {
  test('passes, and packages every file it named', async () => {
    const root = await fixture()
    const inspection = await inspectHandoff({ root })
    assert.equal(inspection.report.status, 'pass')
    assert.deepEqual(inspection.report.findings, [])
    assert.deepEqual(
      inspection.files.map((file) => file.path).sort(),
      [
        'components/button/contract.json',
        'components/button/notes.md',
        'components/button/states/default.json',
        'components/button/states/disabled.json',
        'tokens/color.json',
      ],
    )
  })

  test('counts the components it checked, so a pass is never on no evidence', async () => {
    const report = await auditHandoff({ root: await fixture() })
    assert.equal(report.summary.checked, 1)
    assert.ok(report.summary.checked > 0, 'a pass with checked: 0 would be a pass on nothing')
  })
})

describe('an internal link that does not resolve', () => {
  const brokenLink = [
    {
      what: 'a contract',
      rule: 'source-missing',
      plan: () => planFor({ components: [{ ...planFor().components[0], contract: 'contracts/nope.json' }] }),
    },
    {
      what: 'a usage note',
      rule: 'source-missing',
      plan: () => planFor({ components: [{ ...planFor().components[0], notes: 'notes/nope.md' }] }),
    },
    {
      what: 'a token citation',
      rule: 'token-reference-unresolved',
      plan: () => planFor({ components: [{ ...planFor().components[0], tokensUsed: ['color.brand.tertiary'] }] }),
    },
    {
      what: 'a cross reference to another component',
      rule: 'cross-reference-unresolved',
      plan: () => planFor({ components: [{ ...planFor().components[0], seeAlso: ['split-button'] }] }),
    },
    {
      what: 'a story link inside the root',
      rule: 'story-link-unresolved',
      plan: () => planFor({ components: [{ ...planFor().components[0], story: 'stories/button.md' }] }),
    },
  ]

  for (const { what, rule, plan } of brokenLink) {
    test(`${what} fails the run with ${rule}`, async () => {
      const root = await scratch()
      await writeTree(root, treeFor(plan()))
      const report = await auditHandoff({ root })
      assert.equal(report.status, 'fail')
      assert.ok(report.findings.some((finding) => finding.ruleId === rule), `expected ${rule}, got ${report.findings.map((f) => f.ruleId).join(', ')}`)
    })
  }

  test('a missing token document leaves the citations UNCHECKED rather than unresolved', async () => {
    // The tempting behaviour is to report every citation as unresolved,
    // because the name is not in the set. The set is not the set: it was
    // never read. Absence from a partial set is not evidence of absence, so
    // the run is incomplete and the citation check does not run at all.
    const root = await scratch()
    await writeTree(root, treeFor(planFor({ tokens: [{ id: 'color', source: 'tokens/nope.json' }] })))
    const report = await auditHandoff({ root })
    assert.equal(report.status, 'incomplete')
    const rules = report.findings.map((finding) => finding.ruleId)
    assert.ok(rules.includes('source-missing'))
    assert.ok(rules.includes('token-references-unchecked'))
    assert.ok(!rules.includes('token-reference-unresolved'),
      'a citation was never checked, so it is never reported as unresolved')
  })

  test('a link written inside a usage note fails the run', async () => {
    const root = await fixture(planFor(), {
      'notes/button.md': '# Button\n\nSee the [anatomy](./anatomy.md).\n',
    })
    const report = await auditHandoff({ root })
    assert.equal(report.status, 'fail')
    const finding = report.findings.find((entry) => entry.ruleId === 'note-link-unresolved')
    assert.ok(finding)
    assert.equal(finding.location.file, 'notes/button.md')
    assert.equal(finding.location.pointer, 'line:3')
  })

  test('a link that leaves the root is recorded, never fetched, and does not fail', async () => {
    const root = await fixture(planFor(), {
      'notes/button.md': '# Button\n\n[docs](https://example.invalid/button)\n',
    })
    const report = await auditHandoff({ root })
    assert.equal(report.status, 'pass')
    const finding = report.findings.find((entry) => entry.ruleId === 'note-link-external')
    assert.equal(finding.severity, 'info')
    assert.equal(finding.evidence, 'https://example.invalid/button')
  })

  test('a source reached through a symlink out of the root is refused, not read', async () => {
    const outside = await scratch()
    await writeFile(resolve(outside, 'secret.json'), json({ token: 'not-yours' }))
    const root = await fixture()
    await symlink(resolve(outside, 'secret.json'), resolve(root, 'contracts/button.json'), 'file')
      .catch(async () => {
        await rm(resolve(root, 'contracts/button.json'))
        await symlink(resolve(outside, 'secret.json'), resolve(root, 'contracts/button.json'), 'file')
      })
    const report = await auditHandoff({ root })
    assert.equal(report.status, 'fail')
    assert.ok(report.findings.some((finding) => finding.ruleId === 'source-escapes-root'))
    assert.ok(!JSON.stringify(report).includes('not-yours'), 'out-of-root content must never reach the report')
  })
})

describe('missing required state evidence', () => {
  test('fails when a required state has no entry at all', async () => {
    const base = planFor()
    const plan = planFor({
      components: [{ ...base.components[0], states: [base.components[0].states[0]] }],
    })
    const root = await fixture(plan)
    const report = await auditHandoff({ root })
    assert.equal(report.status, 'fail')
    const finding = report.findings.find((entry) => entry.ruleId === 'state-evidence-missing')
    assert.ok(finding)
    assert.equal(finding.severity, 'error')
    assert.match(finding.message, /required state "disabled"/)
    assert.equal(report.summary.missingStates, 1)
  })

  test('fails when the entry is there but the evidence file is not', async () => {
    const root = await fixture()
    await rm(resolve(root, 'evidence/button-disabled.json'))
    const report = await auditHandoff({ root })
    assert.equal(report.status, 'fail')
    assert.ok(report.findings.some((finding) => finding.ruleId === 'state-evidence-missing'))
  })

  test('nothing is packaged when a required state is missing', async () => {
    const root = await fixture()
    await rm(resolve(root, 'evidence/button-disabled.json'))
    const inspection = await inspectHandoff({ root })
    assert.equal(inspection.manifest, null)
    assert.equal(inspection.files, null)
  })

  test('an evidence file that exists but cannot be read is incomplete, not missing', async () => {
    const root = await fixture()
    await rm(resolve(root, 'evidence/button-disabled.json'))
    await mkdir(resolve(root, 'evidence/button-disabled.json'))
    const report = await auditHandoff({ root })
    assert.ok(report.findings.some((finding) => finding.ruleId === 'source-not-a-file'))
    assert.ok(!report.findings.some((finding) => finding.ruleId === 'state-evidence-missing'),
      'a directory in the way is not evidence of absence')
  })

  test('a state the plan does not require is packaged without complaint', async () => {
    const base = planFor()
    const plan = planFor({
      components: [{
        ...base.components[0],
        states: [...base.components[0].states, { name: 'hover', evidence: 'evidence/button-hover.json' }],
      }],
    })
    const root = await fixture(plan, { 'evidence/button-hover.json': json({ state: 'hover' }) })
    const inspection = await inspectHandoff({ root })
    assert.equal(inspection.report.status, 'pass')
    const hover = inspection.manifest.components[0].states.find((state) => state.name === 'hover')
    assert.equal(hover.required, false)
  })
})

describe('a plan that packages nothing', () => {
  test('is a failure rather than a green run on no evidence', async () => {
    const root = await scratch()
    await writeTree(root, { 'handoff.json': json(planFor({ components: [] })) })
    const report = await auditHandoff({ root })
    assert.equal(report.status, 'fail')
    assert.equal(report.summary.checked, 0)
    assert.ok(report.findings.some((finding) => finding.ruleId === 'no-components'))
  })
})

/**
 * Two token documents under one id.
 *
 * `id-case-collision` refuses two ids that differ only in case, because they
 * would be one file on a case-INSENSITIVE filesystem. Two ids that are exactly
 * equal are one file on EVERY filesystem, and that case had no check at all:
 * the run exited 0 having written four files while reporting five, and the
 * manifest listed `tokens/color.json` twice with two sources, two byte counts
 * and two digests -- one of which described a file that is not the one on disk
 * beside it.
 */
describe('two token documents declared under one id', () => {
  function duplicated() {
    return treeFor(
      planFor({
        tokens: [{ id: 'color', source: 'tokens/color.json' }, { id: 'color', source: 'tokens/other.json' }],
      }),
      { 'tokens/other.json': json({ color: { brand: { secondary: { $value: '#654321' } } } }) },
    )
  }

  test('fail the run rather than packaging one of them over the other', async () => {
    const root = await writeTree(await scratch(), duplicated())
    const inspection = await inspectHandoff({ root })
    assert.ok(ruleIds(inspection.report).includes('duplicate-token-document-id'))
    assert.equal(inspection.manifest, null, 'a plan that does not hold together is not packaged')
    assert.equal(inspection.files, null)
  })

  test('and the finding points at the second declaration, not the first', async () => {
    const root = await writeTree(await scratch(), duplicated())
    const report = await auditHandoff({ root })
    const finding = report.findings.find((entry) => entry.ruleId === 'duplicate-token-document-id')
    assert.equal(finding.location.pointer, '/tokens/1/id')
    assert.match(finding.message, /declared more than once/)
  })

  test('through the command line, nothing is written and the exit code says so', async () => {
    // Exit 2, not 1: the second document was refused rather than indexed, so
    // the citation `color.brand.primary` could not be resolved against the
    // whole token set either. Reporting it as unresolved would be reporting an
    // unknown as an absence, so the run says `incomplete` and says why.
    // `severity-behaviour.test.mjs` pins the rule's own exit code of 1 on a
    // plan that cites no token.
    const root = await writeTree(await scratch(), duplicated())
    const out = resolve(await scratch('dhp-out-'), 'package')
    const result = runCli(['--root', root, '--out', out, '--json'])
    assert.equal(result.code, 2)
    const report = reportFrom(result)
    assert.equal(report.status, 'incomplete')
    assert.ok(ruleIds(report).includes('duplicate-token-document-id'))
    await assert.rejects(readdir(out), { code: 'ENOENT' }, 'nothing was written')
  })

  test('an exact duplicate is caught even when the case rule cannot see it', async () => {
    // `noteCaseCollision` returns null when the folded key maps back to the
    // same spelling, which is exactly what two identical ids do. This test
    // fails if the exact check is deleted and the case rule is left to cover
    // it, which is the shape the defect had.
    const root = await writeTree(await scratch(), duplicated())
    const report = await auditHandoff({ root })
    assert.ok(!ruleIds(report).includes('id-case-collision'),
      'the case rule does not fire here, so it cannot be what refuses this plan')
    assert.notEqual(report.status, 'pass')
  })
})
