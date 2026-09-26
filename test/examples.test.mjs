/**
 * The shipped examples behave exactly as the README says they do.
 *
 * An example that stopped running is a quick start that lies, and the `check`
 * script runs these two anyway -- this file pins WHAT they do, not just that
 * they exit.
 */

import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { cleanup, reportFrom, runCli, scratch } from './support.mjs'

after(cleanup)

describe('examples/clean', () => {
  test('passes, and nothing but info is reported', () => {
    const report = reportFrom(runCli(['--root', 'examples/clean', '--json']))
    assert.equal(report.status, 'pass')
    assert.equal(report.summary.errors, 0)
    assert.equal(report.summary.warnings, 0)
    for (const finding of report.findings) assert.equal(finding.severity, 'info')
  })

  test('packages every file its plan names', async () => {
    const out = resolve(await scratch('dhp-example-'), 'package')
    const result = runCli(['--root', 'examples/clean', '--out', out, '--json'])
    assert.equal(result.code, 0)
    const manifest = JSON.parse(await readFile(resolve(out, 'manifest.json'), 'utf8'))
    assert.equal(manifest.tool, 'design-handoff-packager')
    assert.equal(manifest.components.length, 2)
    assert.deepEqual((await readdir(out)).sort(), ['components', 'manifest.json', 'tokens'])
    for (const file of manifest.files) {
      const bytes = await readFile(resolve(out, ...file.path.split('/')))
      assert.equal(bytes.length, file.bytes)
    }
  })

  test('records the external story link without fetching it', () => {
    const report = reportFrom(runCli(['--root', 'examples/clean', '--json']))
    const finding = report.findings.find((entry) => entry.ruleId === 'story-link-external')
    assert.ok(finding)
    assert.match(finding.evidence, /^https:\/\//)
  })

  test('does not mistake a link inside a fenced block for a broken one', () => {
    const report = reportFrom(runCli(['--root', 'examples/clean', '--json']))
    assert.ok(!report.findings.some((finding) => finding.ruleId === 'note-link-unresolved'))
  })
})

describe('examples/broken', () => {
  test('fails on policy alone, so it exits 1 rather than 2', () => {
    const result = runCli(['--root', 'examples/broken', '--json'])
    assert.equal(result.code, 1)
    const report = reportFrom(result)
    assert.equal(report.status, 'fail')
    assert.deepEqual(
      [...new Set(report.findings.map((finding) => finding.ruleId))].sort(),
      [
        'cross-reference-unresolved',
        'note-link-external',
        'note-link-unresolved',
        'state-evidence-missing',
        'story-link-external',
        'story-link-unresolved',
        'token-reference-unresolved',
      ],
    )
  })

  test('writes nothing', async () => {
    const out = resolve(await scratch('dhp-example-'), 'package')
    const result = runCli(['--root', 'examples/broken', '--out', out])
    assert.equal(result.code, 1)
    await assert.rejects(readdir(out), { code: 'ENOENT' })
  })
})

describe('examples/stale', () => {
  test('needs an injected clock, and passes on one inside its window', () => {
    const result = runCli(['--root', 'examples/stale', '--json', '--now', '2025-01-05T00:00:00Z'])
    const report = reportFrom(result)
    assert.equal(report.status, 'fail')
    // Only the undated states remain: the dated one is one day old here.
    assert.ok(!report.findings.some((finding) => finding.ruleId === 'state-evidence-stale'))
  })

  test('and reports the old capture once the clock has moved on', () => {
    const report = reportFrom(runCli(['--root', 'examples/stale', '--json', '--now', '2026-09-18T00:00:00Z']))
    assert.ok(report.findings.some((finding) => finding.ruleId === 'state-evidence-stale'))
  })
})
