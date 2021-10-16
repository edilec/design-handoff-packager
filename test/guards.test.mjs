/**
 * The refusals nothing else reaches.
 *
 * Every test in this file exists because a mutation survived the suite.
 * Neutralising each `throw` in `src/` one at a time -- turning it into an
 * expression that is evaluated and discarded -- left 16 of them with all 276
 * tests passing. A refusal with no test that fails when it is removed is a
 * refusal that will quietly stop happening.
 *
 * Several of these are backstops that a correct call site cannot reach. That
 * is not a reason to leave them untested; it is the reason they are reached
 * from here, through the exported function rather than through the CLI.
 */

import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdir, symlink, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import {
  DestinationError,
  assertWritableDestination,
  ensureDirectoryWithin,
  excerpt,
  inspectHandoff,
  isIdentifier,
  outcomeFor,
  prepareOutputRoot,
  resolveOutputRoot,
  sameFile,
  severityFor,
  writeHandoffPackage,
} from '../src/index.mjs'
import { cleanup, fixture, json, planFor, runCli, scratch, treeFor, writeTree } from './support.mjs'

after(cleanup)

const runningAsRoot = () => typeof process.getuid === 'function' && process.getuid() === 0

async function refused(run, pattern) {
  const error = await run().then(() => null, (caught) => caught)
  assert.ok(error instanceof DestinationError, `expected a DestinationError, got ${error}`)
  assert.match(error.message, pattern)
  return error
}

describe('the rule tables refuse a rule id they do not hold', () => {
  test('a severity that is not in the table is an error, not undefined', () => {
    assert.equal(severityFor('source-missing'), 'error')
    assert.throws(() => severityFor('sorce-missing'), /Unknown rule id/)
  })

  test('an outcome class that is not in the table is an error, not a silent pass', () => {
    assert.equal(outcomeFor('source-unreadable'), 'evidence')
    assert.throws(() => outcomeFor('source-unreadible'), /has no outcome class/)
  })
})

describe('the library refuses options it cannot act on', () => {
  test('options that are not an object', async () => {
    await assert.rejects(() => inspectHandoff('examples/clean'), /Options must be an object/)
    await assert.rejects(() => inspectHandoff(null), /Options must be an object/)
  })

  test('a plan path that is not a non-empty string', async () => {
    const root = await fixture()
    await assert.rejects(() => inspectHandoff({ root, plan: '   ' }), /plan path must be a non-empty string/)
    await assert.rejects(() => inspectHandoff({ root, plan: 7 }), /plan path must be a non-empty string/)
  })

  test('a package that was never assembled', async () => {
    const base = planFor()
    const root = await writeTree(await scratch('dhp-src-'), treeFor(planFor({
      components: [{ ...base.components[0], seeAlso: ['nope'] }],
    })))
    const inspection = await inspectHandoff({ root })
    const out = resolve(await scratch(), 'package')
    await assert.rejects(
      () => writeHandoffPackage(inspection, { out }),
      /only from a plan that passed/,
    )
  })

  test('a write with no output directory named', async () => {
    const inspection = await inspectHandoff({ root: await fixture() })
    await assert.rejects(() => writeHandoffPackage(inspection, {}), /output directory is required/)
    await assert.rejects(() => writeHandoffPackage(inspection, { out: '  ' }), /output directory is required/)
  })

  test('an excerpt limit that is not a positive integer', () => {
    assert.equal(excerpt('abc', 2), 'ab...')
    assert.throws(() => excerpt('abc', 0), /Excerpt limit must be a positive integer/)
    assert.throws(() => excerpt('abc', 1.5), /Excerpt limit must be a positive integer/)
  })
})

describe('a plan that reaches outside the root through a link', () => {
  test('is refused, even though its written path is inside', async () => {
    // A lexical check passes here: `elsewhere.json` names nothing outside the
    // root. Only resolving the real path sees that it does.
    const outside = await scratch()
    await writeTree(outside, { 'real.json': json(planFor()) })
    const root = await writeTree(await scratch(), treeFor())
    await symlink(resolve(outside, 'real.json'), resolve(root, 'elsewhere.json'), 'file')

    await assert.rejects(
      () => inspectHandoff({ root, plan: 'elsewhere.json' }),
      /must resolve inside the root/,
    )
    const result = runCli(['--root', root, '--plan', 'elsewhere.json', '--json'])
    assert.equal(result.code, 2)
    assert.equal(result.stdout, '', 'a configuration error leaves stdout empty')
  })
})

describe('containment is decided on a path boundary, not a string prefix', () => {
  test('a sibling directory whose name merely begins with the root is outside it', async () => {
    const parent = await scratch()
    const root = await writeTree(resolve(parent, 'root'), treeFor())
    const sibling = resolve(parent, 'rootx')
    await mkdir(sibling)
    // `rootx` starts with `root`, so a prefix check calls it inside and
    // refuses this run.
    const inspection = await inspectHandoff({ root })
    assert.equal(inspection.report.status, 'pass')
    const written = await writeHandoffPackage(inspection, { out: resolve(sibling, 'package') })
    assert.ok(written.written.includes('manifest.json'),
      'a destination beside the root is not inside it and must be allowed')
  })

  test('and a destination genuinely inside the root is still refused', async () => {
    const root = await writeTree(await scratch(), treeFor())
    const inspection = await inspectHandoff({ root })
    await refused(() => writeHandoffPackage(inspection, { out: resolve(root, 'package') }), /overlaps the tree/)
  })
})

describe('assertWritableDestination, asked directly', () => {
  test('refuses a destination that exists and is not a regular file', async () => {
    const target = resolve(await scratch(), 'adir')
    await mkdir(target)
    await refused(() => assertWritableDestination(target), /exists and is not a regular file/)
  })

  test('refuses a destination whose directory does not exist', async () => {
    const directory = await scratch()
    await refused(
      () => assertWritableDestination(resolve(directory, 'missing', 'file.json')),
      /names a directory that does not exist/,
    )
  })

  test('refuses a destination outside the root it was given', async () => {
    // Every file inside the package is confined to the real --out directory.
    // A lexical check passes for `out/through/file`; resolving the parent does
    // not.
    const elsewhere = await scratch('dhp-victim-')
    const out = resolve(await scratch('dhp-out-'), 'package')
    await mkdir(out)
    await symlink(elsewhere, resolve(out, 'through'), 'dir')
    await refused(
      () => assertWritableDestination(resolve(out, 'through', 'file.json'), { root: out, rootLabel: 'the package' }),
      /outside the package/,
    )
  })

  test('refuses a destination it cannot inspect at all', async () => {
    // `lstat` failing with anything but ENOENT is not "there is nothing
    // there". A path segment longer than the filesystem allows is
    // ENAMETOOLONG, and treating that as an empty slot would open a file the
    // guard never looked at.
    const base = await scratch()
    const tooLong = resolve(base, 'x'.repeat(600))
    await refused(() => assertWritableDestination(tooLong), /could not be inspected/)
    await refused(() => resolveOutputRoot(tooLong), /could not be inspected/)
    await refused(() => prepareOutputRoot(tooLong), /could not be inspected/)
  })

  test('allows a destination inside the root it was given', async () => {
    const out = resolve(await scratch('dhp-out-'), 'package')
    await mkdir(out)
    await mkdir(resolve(out, 'inner'))
    const target = await assertWritableDestination(resolve(out, 'inner', 'file.json'), { root: out })
    assert.equal(target, resolve(out, 'inner', 'file.json'))
  })
})

describe('sameFile answers unknown, and unknown is not "different"', () => {
  test('a filesystem that reports no inode cannot rule out a hard link', () => {
    // No filesystem here reports a zero inode, so this branch has no fixture
    // and never will. The predicate is pure and exported for exactly that
    // reason: it is the only way the refusal can have a test that fails when
    // it is removed.
    assert.equal(sameFile({ dev: 1, ino: 0 }, { dev: 1, ino: 5 }), 'unknown')
    assert.equal(sameFile({ dev: 1, ino: 5 }, { dev: 1, ino: 0 }), 'unknown')
    assert.equal(sameFile({ dev: 0, ino: 0 }, { dev: 0, ino: 0 }), 'unknown')
    assert.equal(sameFile({ dev: 1, ino: 5 }, { dev: 1, ino: 5 }), 'same')
    assert.equal(sameFile({ dev: 1, ino: 5 }, { dev: 2, ino: 5 }), 'different')
    assert.equal(sameFile({ dev: 1, ino: 5 }, { dev: 1, ino: 6 }), 'different')
  })

  test('and the destination guard consults it rather than comparing paths', async () => {
    const directory = await scratch()
    const input = resolve(directory, 'input.json')
    const target = resolve(directory, 'output.json')
    await writeFile(input, 'in')
    await writeFile(target, 'out')
    await assertWritableDestination(target, { inputs: [input] })
    await refused(() => assertWritableDestination(target, { inputs: [target] }), /same file as an input/)
  })
})

describe('ensureDirectoryWithin and resolveOutputRoot refuse what is in the way', () => {
  test('a regular file where a package directory must go', async () => {
    const out = resolve(await scratch('dhp-out-'), 'package')
    await mkdir(out)
    await writeFile(resolve(out, 'components'), 'not a directory')
    await refused(() => ensureDirectoryWithin(out, ['components', 'button']), /exists and is not a directory/)
  })

  test('a directory on the way that cannot be inspected', async (t) => {
    if (runningAsRoot()) {
      t.skip('root can enter a mode-000 directory, so the fixture cannot be built')
      return
    }
    const out = resolve(await scratch('dhp-out-'), 'package')
    await mkdir(out)
    await mkdir(resolve(out, 'components'))
    await chmod(resolve(out, 'components'), 0o000)
    const error = await ensureDirectoryWithin(out, ['components', 'button']).then(() => null, (caught) => caught)
    await chmod(resolve(out, 'components'), 0o755)
    assert.ok(error instanceof DestinationError, `expected a DestinationError, got ${error}`)
    assert.match(error.message, /could not be inspected/)
  })

  test('--out naming a regular file', async () => {
    const target = resolve(await scratch('dhp-out-'), 'package')
    await writeFile(target, 'not a directory')
    await refused(() => resolveOutputRoot(target), /exists and is not a directory/)
    await refused(() => prepareOutputRoot(target), /exists and is not a directory/)
  })

  test('--out inside a directory that cannot be written to', async (t) => {
    if (runningAsRoot()) {
      t.skip('root can write inside a read-only directory, so the fixture cannot be built')
      return
    }
    const parent = await scratch('dhp-out-')
    await chmod(parent, 0o555)
    const error = await prepareOutputRoot(resolve(parent, 'package')).then(() => null, (caught) => caught)
    await chmod(parent, 0o755)
    assert.ok(error instanceof DestinationError, `expected a DestinationError, got ${error}`)
    assert.match(error.message, /could not be created/)
  })
})

describe('an identifier is refused by its shape, and the shape is the whole check', () => {
  test('nothing the shape admits is a character the control check would catch', () => {
    // Substituting the control-character check away survives the suite, and
    // this measures exactly why: every character the shape admits sits in the
    // printable ASCII run 0x2D to 0x7A, and every forbidden class lies below
    // 0x20, between 0x7F and 0x9F, or above 0x2000. If the shape is ever
    // widened, this fails and the second check starts mattering again.
    const admitted = []
    for (let code = 0; code <= 0x2200; code += 1) {
      if (isIdentifier(`a${String.fromCharCode(code)}`)) admitted.push(code)
    }
    assert.ok(admitted.length > 60, `the probe found ${admitted.length} admitted characters, which looks wrong`)
    for (const code of admitted) {
      assert.ok(code >= 0x2d && code <= 0x7a,
        `the identifier shape admits U+${code.toString(16)}, which is outside printable ASCII`)
    }
    assert.ok(isIdentifier('a-b_c.d9'))
    assert.ok(!isIdentifier('.hidden'))
    assert.ok(!isIdentifier('a/b'))
  })
})
