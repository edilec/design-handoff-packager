/**
 * The command line surface: which stream carries what, and which exit code
 * goes with it.
 *
 * The contract splits exit 2 in two, and the split is the point: a
 * configuration error means the run never had a subject, so stdout stays
 * EMPTY; an input the run could not read means it had a subject and failed to
 * learn about it, so stdout carries an `incomplete` report naming the input.
 * A consumer that pipes stdout has to handle both, which is why both are
 * pinned here rather than left to the reader.
 */

import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import { cleanup, PACKAGE_ROOT, planFor, runCli, scratch, treeFor, writeTree } from './support.mjs'

after(cleanup)

describe('stdout carries the report and nothing else', () => {
  test('on a pass', async () => {
    const root = await writeTree(await scratch(), treeFor())
    const result = runCli(['--root', root])
    assert.equal(result.code, 0)
    assert.doesNotThrow(() => JSON.parse(result.stdout))
    assert.equal(JSON.parse(result.stdout).tool, 'design-handoff-packager')
    assert.ok(result.stderr.includes('status pass'), 'the human summary belongs on stderr')
  })

  test('on a failure', async () => {
    const base = planFor()
    const root = await writeTree(await scratch(), treeFor(planFor({
      components: [{ ...base.components[0], seeAlso: ['nope'] }],
    })))
    const result = runCli(['--root', root])
    assert.equal(result.code, 1)
    assert.equal(JSON.parse(result.stdout).status, 'fail')
  })

  test('--json suppresses the summary but not the report', async () => {
    const root = await writeTree(await scratch(), treeFor())
    const result = runCli(['--root', root, '--json'])
    assert.equal(result.code, 0)
    assert.equal(JSON.parse(result.stdout).status, 'pass')
    assert.ok(!result.stderr.includes('status pass'))
  })
})

describe('exit 2, shape one: a configuration error leaves stdout empty', () => {
  const cases = [
    { what: 'no arguments at all', args: [] },
    { what: 'an unknown option', args: ['--root', '.', '--verbose'] },
    { what: 'an option with no value', args: ['--root'] },
    { what: 'an unknown limit name', args: ['--root', '.', '--limit', 'maxThings=4'] },
    { what: 'a limit that is not a positive integer', args: ['--root', '.', '--limit', 'maxFiles=0'] },
    { what: 'a limit with no equals sign', args: ['--root', '.', '--limit', 'maxFiles'] },
    { what: '--overwrite with nowhere to write', args: ['--root', '.', '--overwrite'] },
  ]
  for (const { what, args } of cases) {
    test(what, () => {
      const result = runCli(args)
      assert.equal(result.code, 2)
      assert.equal(result.stdout, '', 'a run that never had a subject reports nothing')
      assert.notEqual(result.stderr, '')
    })
  }

  test('a one-character typo in a limit name is an error, not a silent no-op', async () => {
    // The distinction that matters is which SHAPE of exit 2 it is. The
    // correctly spelled name starts a run, so stdout carries a report; the
    // typo never gets that far, so stdout stays empty.
    const root = await writeTree(await scratch(), treeFor())
    const good = runCli(['--root', root, '--limit', 'maxFiles=40'])
    const typo = runCli(['--root', root, '--limit', 'maxFile=40'])
    assert.equal(good.code, 0)
    assert.notEqual(good.stdout, '')
    assert.equal(typo.code, 2)
    assert.equal(typo.stdout, '', 'a typo must never quietly leave the real limit in place')
    assert.match(typo.stderr, /Unknown limit "maxFile"/)
  })
})

describe('exit 2, shape two: an input that could not be read carries a report', () => {
  test('which names the input, because a consumer needs to know which one', async () => {
    const root = await writeTree(await scratch(), { 'handoff.json': '{ not json' })
    const result = runCli(['--root', root])
    assert.equal(result.code, 2)
    assert.notEqual(result.stdout, '')
    const report = JSON.parse(result.stdout)
    assert.equal(report.status, 'incomplete')
    assert.equal(report.findings[0].location.file, 'handoff.json')
  })
})

describe('--help and --version sit outside the exit-code table', () => {
  test('--help prints to stdout and exits 0', () => {
    for (const flag of ['-h', '--help']) {
      const result = runCli([flag])
      assert.equal(result.code, 0, flag)
      assert.match(result.stdout, /^design-handoff-packager/)
      assert.equal(result.stderr, '')
    }
  })

  test('--version prints the version in package.json', async () => {
    const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
    const result = runCli(['--version'])
    assert.equal(result.code, 0)
    assert.equal(result.stdout.trim(), manifest.version)
  })

  test('the help text answers every documented question', () => {
    const help = runCli(['--help']).stdout
    for (const needle of ['--root', '--plan', '--out', '--overwrite', '--now', '--limit', '--json',
      'Exit codes', 'symbolic link', 'hard link', 'is NOT', 'opens no socket']) {
      assert.ok(help.includes(needle), 'the help text never mentions ' + needle)
    }
    assert.ok(PACKAGE_ROOT.length > 0)
  })
})
