/**
 * One test per hole, plus the allowed cases.
 *
 * A guard that refuses everything passes every data-loss test while making the
 * tool useless, so the permitted destinations are pinned just as hard as the
 * refused ones -- including a destination under the macOS temporary directory,
 * where `/var` is a symbolic link to `/private/var` and a naive ancestor check
 * refuses every legitimate run.
 */

import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { link, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { DestinationError, inspectHandoff, writeHandoffPackage } from '../src/index.mjs'
import { cleanup, planFor, runCli, scratch, treeFor, writeTree } from './support.mjs'

after(cleanup)

const VICTIM = 'the bytes that must survive\n'

async function passingRoot(extra = {}, plan = planFor()) {
  return writeTree(await scratch('dhp-src-'), treeFor(plan, extra))
}

async function refused(run) {
  const error = await run().then(() => null, (caught) => caught)
  assert.ok(error instanceof DestinationError, `expected a DestinationError, got ${error}`)
  return error
}

describe('hole 1: a symbolic link at the destination', () => {
  test('a link standing where a package file goes is refused, and its target survives', async () => {
    const root = await passingRoot()
    const elsewhere = await scratch('dhp-victim-')
    const victim = resolve(elsewhere, 'precious.json')
    await writeFile(victim, VICTIM)

    const out = resolve(await scratch('dhp-out-'), 'package')
    await mkdir(out)
    await symlink(victim, resolve(out, 'manifest.json'), 'file')

    const inspection = await inspectHandoff({ root })
    const error = await refused(() => writeHandoffPackage(inspection, { out, overwrite: true }))
    assert.match(error.message, /symbolic link/)
    assert.equal(await readFile(victim, 'utf8'), VICTIM)
  })

  test('--out itself being a link is refused before anything is created', async () => {
    const root = await passingRoot()
    const elsewhere = await scratch('dhp-victim-')
    const out = resolve(await scratch('dhp-out-'), 'package')
    await symlink(elsewhere, out, 'dir')

    const result = runCli(['--root', root, '--out', out])
    assert.equal(result.code, 2)
    assert.equal(result.stdout, '', 'a refused destination is a configuration error: stdout stays empty')
    assert.match(result.stderr, /symbolic link/)
    assert.deepEqual(await readdir(elsewhere), [])
  })

  test('a link to a path that does not exist yet is refused, not followed into creating one', async () => {
    const root = await passingRoot()
    const elsewhere = await scratch('dhp-victim-')
    const out = resolve(await scratch('dhp-out-'), 'package')
    await mkdir(out)
    await symlink(resolve(elsewhere, 'not-yet.json'), resolve(out, 'manifest.json'), 'file')

    const inspection = await inspectHandoff({ root })
    await refused(() => writeHandoffPackage(inspection, { out, overwrite: true }))
    assert.deepEqual(await readdir(elsewhere), [], 'nothing outside the package was created')
  })
})

describe('hole 2: a symbolically linked parent directory', () => {
  test('a linked directory inside --out is refused, and mkdir never walks through it', async () => {
    const root = await passingRoot()
    const elsewhere = await scratch('dhp-victim-')
    await writeFile(resolve(elsewhere, 'keep.txt'), VICTIM)

    const out = resolve(await scratch('dhp-out-'), 'package')
    await mkdir(out)
    // `components/button/contract.json` is the first file written into a
    // subdirectory, so `components` is the segment mkdir would follow.
    await symlink(elsewhere, resolve(out, 'components'), 'dir')

    const inspection = await inspectHandoff({ root })
    const error = await refused(() => writeHandoffPackage(inspection, { out, overwrite: true }))
    assert.match(error.message, /symbolic link/)
    assert.deepEqual((await readdir(elsewhere)).sort(), ['keep.txt'],
      'nothing was created through the link')
    assert.equal(await readFile(resolve(elsewhere, 'keep.txt'), 'utf8'), VICTIM)
  })
})

describe('hole 3: a hard link to an input', () => {
  test('a destination hard-linked to a file the run READ is refused', async () => {
    const root = await passingRoot()
    const out = resolve(await scratch('dhp-out-'), 'package')
    await mkdir(out)
    await mkdir(resolve(out, 'tokens'))
    // No target to resolve and no shared path: realpath and string comparison
    // both call this a different file. Only dev+ino sees that it is not.
    await link(resolve(root, 'contracts/button.json'), resolve(out, 'tokens/color.json'))
    const before = await readFile(resolve(root, 'contracts/button.json'), 'utf8')

    const inspection = await inspectHandoff({ root })
    const error = await refused(() => writeHandoffPackage(inspection, { out, overwrite: true }))
    assert.match(error.message, /inode/)
    assert.equal(await readFile(resolve(root, 'contracts/button.json'), 'utf8'), before)
  })

  test('a destination hard-linked to a file the run only NAMED is refused', async () => {
    // The lesson that cost this build a source file: the input set is every
    // path the tool stats, lists or reasons about, not the ones it opens. A
    // note's link target is stat-ed and never read.
    const root = await passingRoot({
      'notes/button.md': '# Button\n\n![diagram](./diagram.png)\n',
      'notes/diagram.png': VICTIM,
    })
    const out = resolve(await scratch('dhp-out-'), 'package')
    await mkdir(out)
    await link(resolve(root, 'notes/diagram.png'), resolve(out, 'manifest.json'))

    const inspection = await inspectHandoff({ root })
    assert.equal(inspection.report.status, 'pass')
    const error = await refused(() => writeHandoffPackage(inspection, { out, overwrite: true }))
    assert.match(error.message, /inode/)
    assert.equal(await readFile(resolve(root, 'notes/diagram.png'), 'utf8'), VICTIM)
  })
})

describe('the package never overlaps the tree it was made from', () => {
  test('--out inside the root is refused', async () => {
    const root = await passingRoot()
    const result = runCli(['--root', root, '--out', resolve(root, 'package')])
    assert.equal(result.code, 2)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /overlaps the tree being packaged/)
  })

  test('and is refused while it is still only a path, so the source tree is untouched', async () => {
    // The overlap check used to run AFTER the destination had been created,
    // which left a new empty directory inside a tree the README says is never
    // modified, on a run that then exited 2.
    const root = await passingRoot()
    const before = (await readdir(root, { recursive: true })).sort()
    const result = runCli(['--root', root, '--out', resolve(root, 'package')])
    assert.equal(result.code, 2)
    assert.deepEqual((await readdir(root, { recursive: true })).sort(), before,
      'the run created something inside the tree it was packaging')
  })

  test('--out containing the root is refused', async () => {
    const enclosing = await scratch('dhp-enclosing-')
    const root = await writeTree(resolve(enclosing, 'source'), treeFor())
    const result = runCli(['--root', root, '--out', enclosing, '--overwrite'])
    assert.equal(result.code, 2)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /overlaps the tree being packaged/)
  })
})

describe('destinations that must be allowed', () => {
  test('a fresh directory under the system temporary directory is written', async () => {
    // On macOS the temporary directory sits behind /var -> /private/var. A
    // guard that refuses every symbolically linked ancestor refuses this, and
    // a guard nobody can use is a guard everybody turns off.
    const root = await passingRoot()
    const out = resolve(await scratch('dhp-out-'), 'package')
    const result = runCli(['--root', root, '--out', out, '--json'])
    assert.equal(result.code, 0)
    assert.ok((await readdir(out)).includes('manifest.json'))
  })

  test('an existing empty directory is written', async () => {
    const root = await passingRoot()
    const out = resolve(await scratch('dhp-out-'), 'package')
    await mkdir(out)
    const result = runCli(['--root', root, '--out', out, '--json'])
    assert.equal(result.code, 0)
    assert.ok((await readdir(out)).includes('manifest.json'))
  })

  test('a non-empty directory needs --overwrite, and gets it', async () => {
    const root = await passingRoot()
    const out = resolve(await scratch('dhp-out-'), 'package')
    await mkdir(out)
    await writeFile(resolve(out, 'README.txt'), VICTIM)

    const refusedRun = runCli(['--root', root, '--out', out, '--json'])
    assert.equal(refusedRun.code, 2)
    assert.equal(refusedRun.stdout, '')
    assert.deepEqual((await readdir(out)).sort(), ['README.txt'])

    const allowed = runCli(['--root', root, '--out', out, '--overwrite', '--json'])
    assert.equal(allowed.code, 0)
    assert.ok((await readdir(out)).includes('manifest.json'))
    assert.equal(await readFile(resolve(out, 'README.txt'), 'utf8'), VICTIM)
  })

  test('a parent that does not exist is refused rather than conjured', async () => {
    const root = await passingRoot()
    const out = resolve(await scratch('dhp-out-'), 'missing', 'package')
    const result = runCli(['--root', root, '--out', out])
    assert.equal(result.code, 2)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /parent directory that does not exist/)
  })

  test('a failing plan writes nothing at all', async () => {
    const base = planFor()
    const root = await writeTree(await scratch('dhp-src-'), treeFor(planFor({
      components: [{ ...base.components[0], seeAlso: ['nope'] }],
    })))
    const out = resolve(await scratch('dhp-out-'), 'package')
    const result = runCli(['--root', root, '--out', out])
    assert.equal(result.code, 1)
    assert.match(result.stderr, /Nothing was written/)
    await assert.rejects(readdir(out), { code: 'ENOENT' })
  })
})

describe('the library refuses to package an inspection that did not pass', () => {
  test('so a caller cannot write a manifest pointing at files that were not found', async () => {
    const base = planFor()
    const root = await writeTree(await scratch('dhp-src-'), treeFor(planFor({
      components: [{ ...base.components[0], seeAlso: ['nope'] }],
    })))
    const inspection = await inspectHandoff({ root })
    const out = resolve(await scratch(), 'package')
    await assert.rejects(() => writeHandoffPackage(inspection, { out }), TypeError)
  })

  test('and a run with no --out writes nothing anywhere it could reach', async () => {
    // What this replaces asserted `readdir()` of a fresh scratch directory the
    // CLI was never told about, and `JSON.stringify({}, null, 2) === '{}'`. Two
    // constants. A mutation that wrote a whole package into `tmpdir()` on
    // every run with no --out left the entire suite green.
    //
    // A tool cannot be proven to have written nothing to the whole filesystem,
    // so the three places a run could plausibly reach without being told to
    // are each pointed at an empty directory of their own, and the tree it was
    // given is compared before and after.
    const root = await passingRoot()
    const before = (await readdir(root, { recursive: true })).sort()
    const cwd = await scratch('dhp-cwd-')
    const temporary = await scratch('dhp-tmp-')
    const home = await scratch('dhp-home-')

    const result = runCli(['--root', root, '--json'], {
      cwd,
      env: { TMPDIR: temporary, TMP: temporary, TEMP: temporary, HOME: home },
    })

    assert.equal(result.code, 0, result.stderr)
    assert.deepEqual(await readdir(cwd, { recursive: true }), [], 'the working directory')
    assert.deepEqual(await readdir(temporary, { recursive: true }), [], 'the temporary directory')
    assert.deepEqual(await readdir(home, { recursive: true }), [], 'the home directory')
    assert.deepEqual((await readdir(root, { recursive: true })).sort(), before, 'the tree it was given')
  })
})

/**
 * A destination refused part-way through the write.
 *
 * Every file used to be written as its own destination was checked, so a
 * refusal on the twelfth file left eleven package files on disk and no
 * manifest -- while the exit code, the README exit-code table and the help
 * text all said nothing had been written. A directory holding most of a
 * package and no manifest is exactly the artifact this tool exists to prevent.
 */
describe('a refusal part-way through the package', () => {
  async function refusedMidWrite() {
    const root = await passingRoot()
    const out = resolve(await scratch('dhp-out-'), 'package')
    await mkdir(out)
    await mkdir(resolve(out, 'tokens'))
    // `tokens/color.json` sorts last among the package files, so eleven files
    // precede it. It is a hard link to a file the run read, which is refused
    // by device and inode.
    await link(resolve(root, 'contracts/button.json'), resolve(out, 'tokens/color.json'))
    return { root, out }
  }

  test('writes no file at all, not just the ones after it', async () => {
    const { root, out } = await refusedMidWrite()
    const result = runCli(['--root', root, '--out', out, '--overwrite', '--json'])
    assert.equal(result.code, 2)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /inode/)

    const survivors = (await readdir(out, { recursive: true, withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort()
    assert.deepEqual(survivors, ['color.json'],
      'only the hard link that was already there may remain')
  })

  test('and the file that was refused is left exactly as it was', async () => {
    const { root, out } = await refusedMidWrite()
    const before = await readFile(resolve(root, 'contracts/button.json'), 'utf8')
    runCli(['--root', root, '--out', out, '--overwrite', '--json'])
    assert.equal(await readFile(resolve(root, 'contracts/button.json'), 'utf8'), before)
    assert.equal(await readFile(resolve(out, 'tokens/color.json'), 'utf8'), before)
  })

  test('and no manifest is left claiming a package that is not there', async () => {
    const { root, out } = await refusedMidWrite()
    runCli(['--root', root, '--out', out, '--overwrite', '--json'])
    await assert.rejects(readFile(resolve(out, 'manifest.json')), { code: 'ENOENT' })
  })
})

describe('one package path, one file', () => {
  test('a library caller cannot write two different files to one path', async () => {
    // The plan-level rules -- duplicate component id, duplicate state,
    // duplicate token document id, and the case-collision rule behind all
    // three -- are what keep this true for the command line. This is the
    // backstop that does not take their word for it, on the exported API.
    const root = await passingRoot()
    const inspection = await inspectHandoff({ root })
    const doubled = {
      ...inspection,
      files: [...inspection.files, { ...inspection.files[0], source: 'elsewhere.json' }],
    }
    const out = resolve(await scratch('dhp-out-'), 'package')
    await assert.rejects(() => writeHandoffPackage(doubled, { out }), TypeError)
    await assert.rejects(readdir(out), { code: 'ENOENT' }, 'nothing was written')
  })
})
