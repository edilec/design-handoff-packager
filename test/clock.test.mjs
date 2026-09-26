/**
 * The clock is injected, and most runs never read one at all.
 *
 * The proof that no clock is read is a clock that throws: if anything on the
 * path touches it, the run fails loudly instead of quietly depending on the
 * day it was run.
 */

import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'

import { auditHandoff, inspectHandoff } from '../src/index.mjs'
import { cleanup, planFor, reportFrom, runCli, scratch, treeFor, writeTree } from './support.mjs'

after(cleanup)

const DAY = 86400000
const base = planFor()

function exploding() {
  throw new Error('the clock was read, and this run declared no window')
}

function windowed(days, capturedAt) {
  return planFor({
    evidenceMaxAgeDays: days,
    components: [{
      ...base.components[0],
      states: base.components[0].states.map((state) => ({ ...state, capturedAt })),
    }],
  })
}

describe('a plan with no age window', () => {
  test('never reads a clock', async () => {
    const root = await writeTree(await scratch(), treeFor())
    const report = await auditHandoff({ root, now: exploding })
    assert.equal(report.status, 'pass')
  })

  test('and the CLI does not read one either', async () => {
    const root = await writeTree(await scratch(), treeFor())
    const first = runCli(['--root', root, '--json'])
    const second = runCli(['--root', root, '--json'])
    assert.equal(first.stdout, second.stdout)
    assert.equal(first.code, 0)
  })
})

describe('a plan with an age window', () => {
  const captured = Date.UTC(2026, 0, 1, 0, 0, 0)

  test('passes while the clock is inside the window', async () => {
    const root = await writeTree(await scratch(), treeFor(windowed(30, '2026-01-01T00:00:00Z')))
    const report = await auditHandoff({ root, now: () => captured + 29 * DAY })
    assert.equal(report.status, 'pass')
  })

  test('fails once the same clock is stepped past it', async () => {
    const root = await writeTree(await scratch(), treeFor(windowed(30, '2026-01-01T00:00:00Z')))
    const report = await auditHandoff({ root, now: () => captured + 31 * DAY })
    assert.equal(report.status, 'fail')
    const stale = report.findings.filter((finding) => finding.ruleId === 'state-evidence-stale')
    assert.equal(stale.length, 2)
    assert.match(stale[0].message, /31 day\(s\) ago/)
  })

  test('treats the boundary itself as inside the window', async () => {
    const root = await writeTree(await scratch(), treeFor(windowed(30, '2026-01-01T00:00:00Z')))
    const atBoundary = await auditHandoff({ root, now: () => captured + 30 * DAY })
    assert.equal(atBoundary.status, 'pass')
    const justPast = await auditHandoff({ root, now: () => captured + 30 * DAY + 1 })
    assert.equal(justPast.status, 'fail')
  })

  test('refuses undated evidence rather than assuming it is fresh', async () => {
    const root = await writeTree(await scratch(), treeFor(planFor({ evidenceMaxAgeDays: 30 })))
    const report = await auditHandoff({ root, now: () => captured })
    assert.equal(report.status, 'fail')
    assert.equal(report.findings.filter((finding) => finding.ruleId === 'state-evidence-undated').length, 2)
  })

  test('refuses evidence captured in the future, which has no decidable age', async () => {
    const root = await writeTree(await scratch(), treeFor(windowed(30, '2026-06-01T00:00:00Z')))
    const report = await auditHandoff({ root, now: () => captured })
    assert.equal(report.status, 'fail')
    assert.ok(report.findings.some((finding) => finding.ruleId === 'state-evidence-undated'))
  })

  test('puts nothing clock-derived in the manifest', async () => {
    const root = await writeTree(await scratch(), treeFor(windowed(3650, '2026-01-01T00:00:00Z')))
    const early = await inspectHandoff({ root, now: () => captured + DAY })
    const late = await inspectHandoff({ root, now: () => captured + 3000 * DAY })
    assert.equal(early.report.status, 'pass')
    assert.equal(late.report.status, 'pass')
    assert.equal(JSON.stringify(early.manifest), JSON.stringify(late.manifest))
  })
})

describe('--now is wired all the way through', () => {
  test('a documented option that the CLI ignored would be a limit that never bites', async () => {
    const root = await writeTree(await scratch(), treeFor(windowed(30, '2026-01-01T00:00:00Z')))
    const inside = runCli(['--root', root, '--json', '--now', '2026-01-15T00:00:00Z'])
    const outside = runCli(['--root', root, '--json', '--now', '2026-06-15T00:00:00Z'])
    assert.equal(inside.code, 0)
    assert.equal(outside.code, 1)
    assert.ok(reportFrom(outside).findings.some((finding) => finding.ruleId === 'state-evidence-stale'))
  })

  test('an instant the calendar does not have is refused', () => {
    const cases = ['2026-02-31T00:00:00Z', '2026-13-01T00:00:00Z', '2026-01-01T24:00:00Z', '2026-01-01T00:00:00+05:30', 'yesterday']
    for (const value of cases) {
      const result = runCli(['--root', '.', '--json', '--now', value])
      assert.equal(result.code, 2, value)
      assert.equal(result.stdout, '', value + ' must leave stdout empty')
    }
  })

  test('now must be a function, not a number somebody hoped would work', async () => {
    const root = await writeTree(await scratch(), treeFor())
    await assert.rejects(() => auditHandoff({ root, now: 123 }), TypeError)
  })
})
