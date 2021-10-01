/**
 * "Paths are relative and reproducible across machines."
 *
 * A machine is approximated here by an absolute location: the same tree is
 * built twice, under two temporary roots of two different lengths, and the
 * manifests are compared byte for byte. That is the property a handoff needs
 * -- the person opening the package is not on the machine that made it.
 */

import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve, sep } from 'node:path'

import { inspectHandoff, writeHandoffPackage } from '../src/index.mjs'
import { cleanup, json, planFor, reportFrom, runCli, scratch, treeFor, writeTree } from './support.mjs'

after(cleanup)

function walk(value, visit, path = '') {
  visit(value, path)
  if (Array.isArray(value)) value.forEach((entry, index) => walk(entry, visit, `${path}/${index}`))
  else if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) walk(entry, visit, `${path}/${key}`)
  }
}

/**
 * Assert the guarantee on one document, wherever it came from.
 *
 * `startsWith('/')` is not the whole check and never was: a MESSAGE carrying
 * an absolute path does not start with one. `root-unreadable` put the caller's
 * whole absolute root inside its message, and this walker was only ever run
 * against a passing tree, so it never met it.
 */
function assertNoHostPath(document, root, label) {
  const text = JSON.stringify(document)
  assert.ok(!text.includes(root), `${label}: the root appears in the output`)
  walk(document, (value, path) => {
    if (typeof value !== 'string') return
    // A JSON Pointer is a documented field path into the plan and starts with
    // `/` by RFC 6901. It is the one string in the report that legitimately
    // looks like an absolute path, and it is the reason this walker cannot be
    // only a `startsWith('/')` check.
    if (path.endsWith('/pointer')) {
      assert.ok(!value.includes(root), `${label}: ${path} carries the root: ${value}`)
      return
    }
    assert.ok(!value.startsWith('/'), `${label}: ${path} is an absolute path: ${value}`)
    assert.ok(!value.includes(`..${sep}`), `${label}: ${path} climbs out of the package: ${value}`)
    assert.ok(!/(?:^|[\s(])\/[A-Za-z0-9._-]+\//.test(value),
      `${label}: ${path} carries an absolute host path: ${value}`)
  })
}

describe('the manifest is the same on two machines', () => {
  test('two roots at different absolute paths produce byte-identical manifests', async () => {
    const first = await writeTree(await scratch('dhp-a-'), treeFor())
    const second = await writeTree(await scratch('dhp-a-much-longer-prefix-'), treeFor())
    assert.notEqual(first, second)
    assert.notEqual(first.length, second.length, 'the two roots must differ in length, or the test proves nothing')

    const left = await inspectHandoff({ root: first })
    const right = await inspectHandoff({ root: second })
    assert.equal(left.report.status, 'pass')
    assert.equal(
      JSON.stringify(left.manifest, null, 2),
      JSON.stringify(right.manifest, null, 2),
    )
  })

  test('the written package is byte-identical from either root', async () => {
    const first = await writeTree(await scratch('dhp-b-'), treeFor())
    const second = await writeTree(await scratch('dhp-b-with-a-longer-name-'), treeFor())
    const outLeft = resolve(await scratch(), 'left')
    const outRight = resolve(await scratch(), 'right')
    await writeHandoffPackage(await inspectHandoff({ root: first }), { out: outLeft })
    await writeHandoffPackage(await inspectHandoff({ root: second }), { out: outRight })
    for (const relative of ['manifest.json', 'components/button/contract.json', 'tokens/color.json']) {
      assert.deepEqual(
        await readFile(resolve(outLeft, relative)),
        await readFile(resolve(outRight, relative)),
        relative,
      )
    }
  })

  test('no absolute host path reaches the report or the manifest', async () => {
    const root = await writeTree(await scratch(), treeFor())
    const inspection = await inspectHandoff({ root })
    assertNoHostPath(inspection.report, root, 'report')
    assertNoHostPath(inspection.manifest, root, 'manifest')
  })

  test('nor to a report from a run that failed', async () => {
    const base = planFor()
    const root = await writeTree(await scratch(), treeFor(planFor({
      components: [{ ...base.components[0], contract: 'contracts/nope.json', seeAlso: ['gone'] }],
    })))
    const result = runCli(['--root', root, '--json'])
    assert.equal(result.code, 1)
    assertNoHostPath(reportFrom(result), root, 'failing report')
  })

  test('nor to a report from a run that could not read its evidence', async () => {
    const root = await writeTree(await scratch(), { 'other.json': '{}' })
    const result = runCli(['--root', root, '--json'])
    assert.equal(result.code, 2)
    assertNoHostPath(reportFrom(result), root, 'plan-unreadable report')
  })

  test('nor to the one report that is emitted before the root is even resolved', async () => {
    // `root-unreadable` is the only finding raised before anything is known to
    // be relative to anything, and it embedded the caller's whole absolute
    // root in its message. The walker above was never run against it.
    const parent = await scratch()
    const root = resolve(parent, 'not-there')
    const result = runCli(['--root', root, '--json'])
    assert.equal(result.code, 2)
    const report = reportFrom(result)
    assert.deepEqual(report.findings.map((finding) => finding.ruleId), ['root-unreadable'])
    assertNoHostPath(report, parent, 'root-unreadable report')
    assert.ok(!JSON.stringify(report).includes('not-there'), 'the root must not appear in output')
  })

  test('every manifest path uses "/" and names a file that was written', async () => {
    const root = await writeTree(await scratch(), treeFor())
    const out = resolve(await scratch(), 'package')
    const inspection = await inspectHandoff({ root })
    const written = await writeHandoffPackage(inspection, { out })
    for (const file of inspection.manifest.files) {
      assert.ok(!file.path.includes('\\'), file.path)
      assert.ok(written.written.includes(file.path), `${file.path} is in the manifest but was not written`)
      const bytes = await readFile(resolve(out, ...file.path.split('/')))
      assert.equal(bytes.length, file.bytes)
    }
    assert.ok(written.written.includes('manifest.json'))
  })
})

describe('the same input twice', () => {
  test('produces byte-identical stdout', async () => {
    const root = await writeTree(await scratch(), treeFor())
    const first = runCli(['--root', root, '--json'])
    const second = runCli(['--root', root, '--json'])
    assert.equal(first.code, 0)
    assert.equal(first.stdout, second.stdout)
    assert.notEqual(first.stdout, '')
  })

  test('produces byte-identical stdout for a failing plan too', async () => {
    const base = planFor()
    const plan = planFor({ components: [{ ...base.components[0], seeAlso: ['nope'] }] })
    const root = await writeTree(await scratch(), treeFor(plan))
    const first = runCli(['--root', root, '--json'])
    const second = runCli(['--root', root, '--json'])
    assert.equal(first.code, 1)
    assert.equal(first.stdout, second.stdout)
  })
})

describe('the plan must resolve inside the root', () => {
  test('so that no report line can carry a path from outside it', async () => {
    const outside = await scratch()
    await writeTree(outside, { 'elsewhere.json': json(planFor()) })
    const root = await writeTree(await scratch(), treeFor())
    const result = runCli(['--root', root, '--plan', resolve(outside, 'elsewhere.json')])
    assert.equal(result.code, 2)
    assert.equal(result.stdout, '', 'a configuration error leaves stdout empty')
    assert.match(result.stderr, /must resolve inside the root/)
  })

  test('and a plan outside the root that does not exist is refused the same way', async () => {
    // Containment used to be decided only after `realpath` succeeded, so this
    // case fell through to a report whose `location.file` climbed out of the
    // root with `../` segments. Whether the file is there is a different
    // question from whether the caller was allowed to name it.
    const root = await writeTree(await scratch(), treeFor())
    const result = runCli(['--root', root, '--plan', resolve(await scratch(), 'never-written.json')])
    assert.equal(result.code, 2)
    assert.equal(result.stdout, '', 'a configuration error leaves stdout empty')
    assert.match(result.stderr, /must resolve inside the root/)
  })

  test('and the answer does not depend on how deep the root happens to sit', async () => {
    // The report bytes for one configuration used to carry one `../` per
    // directory above the root, so the same plan and the same tree produced
    // different output on two machines.
    const shallow = await writeTree(resolve(await scratch(), 'r'), treeFor())
    const deep = await writeTree(resolve(await scratch(), 'a', 'b', 'c', 'd', 'e', 'r'), treeFor())
    const outside = resolve(await scratch(), 'never-written.json')
    const left = runCli(['--root', shallow, '--plan', outside, '--json'])
    const right = runCli(['--root', deep, '--plan', outside, '--json'])
    assert.equal(left.code, right.code)
    assert.equal(left.stdout, right.stdout)
    assert.equal(left.stderr, right.stderr)
  })
})
