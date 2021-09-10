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
import { cleanup, json, planFor, runCli, scratch, treeFor, writeTree } from './support.mjs'

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

  test('and a plan that names no output directory writes nothing', async () => {
    const root = await passingRoot()
    const scratchRoot = await scratch('dhp-out-')
    const result = runCli(['--root', root, '--json'])
    assert.equal(result.code, 0)
    assert.deepEqual(await readdir(scratchRoot), [])
    assert.equal(json({}), '{}')
  })
})
