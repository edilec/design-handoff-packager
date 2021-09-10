/**
 * Ordering, pinned on what the tool emits.
 *
 * A source scan for `localeCompare` is not a determinism test: substituting
 * `Intl.Collator` produces identical collation drift with different source
 * text, so the scan passes while ordering silently becomes machine-dependent.
 *
 * Every fixture below is chosen because code-unit order and collation order
 * disagree about it. `Z` sorts before `a` by code unit (0x5A before 0x61) and
 * after it under collation, which sorts by letter first. `a-b` sorts before
 * `a.md` by code unit (0x2D before 0x2E) while collation treats both marks as
 * ignorable punctuation. If the comparator changes, these assertions move.
 */

import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'

import { byCodeUnit, inspectHandoff } from '../src/index.mjs'
import { cleanup, json, planFor, scratch, treeFor, writeTree } from './support.mjs'

after(cleanup)

const NOTES = ['README.md', 'Z.md', 'a-b.md', 'a.md', 'a_b.md', 'assets.md']

describe('findings are ordered by code unit, not by collation', () => {
  test('six notes, each with one broken link, come out in code-unit order', async () => {
    const base = planFor()
    const components = NOTES.map((name, index) => ({
      id: 'c' + index,
      contract: 'contracts/button.json',
      notes: 'notes/' + name,
      tokensUsed: [],
      seeAlso: [],
      states: base.components[0].states,
    }))
    const extra = {}
    for (const name of NOTES) extra['notes/' + name] = '[missing](./nowhere-' + name + ')\n'
    const root = await writeTree(await scratch(), treeFor(planFor({ components }), extra))

    const report = (await inspectHandoff({ root })).report
    const files = report.findings
      .filter((finding) => finding.ruleId === 'note-link-unresolved')
      .map((finding) => finding.location.file)
    assert.deepEqual(files, [
      'notes/README.md',
      'notes/Z.md',
      'notes/a-b.md',
      'notes/a.md',
      'notes/a_b.md',
      'notes/assets.md',
    ])
    // The premise: this order is genuinely different from the collated one.
    const collated = [...files].sort((left, right) => new Intl.Collator('en').compare(left, right))
    assert.notDeepEqual(collated, files, 'the fixture must distinguish the two orders, or it pins nothing')
  })

  test('two findings alike but for their message are ordered by it', async () => {
    // Both links sit on line 1 of the same note, so they tie on file, pointer
    // and rule. The emitted order is the REVERSE of the order they are
    // written in, so this assertion cannot be satisfied by the order the
    // regular expression happened to match.
    const root = await writeTree(await scratch(), treeFor(planFor(), {
      'notes/button.md': '[one](./zzz-missing.md) and [two](./aaa-missing.md)' + String.fromCharCode(10),
    }))
    const report = (await inspectHandoff({ root })).report
    const found = report.findings.filter((finding) => finding.ruleId === 'note-link-unresolved')
    assert.equal(found.length, 2)
    assert.equal(found[0].location.pointer, found[1].location.pointer, 'the fixture must tie on pointer')
    assert.match(found[0].message, /aaa-missing/)
    assert.match(found[1].message, /zzz-missing/)
  })

  test('two findings alike even in message are ordered by evidence', async () => {
    // An external link carries one fixed sentence, so two of them on one line
    // tie on file, pointer, rule AND message. Only evidence separates them,
    // and again the emitted order reverses the written one.
    const root = await writeTree(await scratch(), treeFor(planFor(), {
      'notes/button.md': '[z](https://z.invalid/) and [a](https://a.invalid/)' + String.fromCharCode(10),
    }))
    const report = (await inspectHandoff({ root })).report
    const found = report.findings.filter((finding) => finding.ruleId === 'note-link-external')
    assert.equal(found.length, 2)
    assert.equal(found[0].message, found[1].message, 'the fixture must tie on message, or it pins nothing')
    assert.equal(found[0].location.pointer, found[1].location.pointer)
    assert.deepEqual(found.map((finding) => finding.evidence), ['https://a.invalid/', 'https://z.invalid/'])
  })
})

describe('the manifest orders every list by code unit', () => {
  test('token names, citations and cross references', async () => {
    const base = planFor()
    const plan = planFor({
      tokens: [{ id: 'color', source: 'tokens/color.json' }],
      components: [
        {
          ...base.components[0],
          tokensUsed: ['color.a_b', 'color.Z', 'color.a-b'],
          seeAlso: ['icon_button', 'Icon', 'icon-button'],
        },
        { id: 'Icon', contract: 'contracts/button.json', tokensUsed: [], seeAlso: [], states: base.components[0].states },
        { id: 'icon-button', contract: 'contracts/button.json', tokensUsed: [], seeAlso: [], states: base.components[0].states },
        { id: 'icon_button', contract: 'contracts/button.json', tokensUsed: [], seeAlso: [], states: base.components[0].states },
      ],
    })
    const root = await writeTree(await scratch(), treeFor(plan, {
      'tokens/color.json': json({
        color: {
          'a_b': { $value: '#1' },
          Z: { $value: '#2' },
          'a-b': { $value: '#3' },
        },
      }),
    }))
    const inspection = await inspectHandoff({ root })
    assert.equal(inspection.report.status, 'pass')
    assert.deepEqual(inspection.manifest.tokens[0].names, ['color.Z', 'color.a-b', 'color.a_b'])
    assert.deepEqual(inspection.manifest.components[0].id, 'Icon')
    const button = inspection.manifest.components.find((entry) => entry.id === 'button')
    assert.deepEqual(button.tokensUsed, ['color.Z', 'color.a-b', 'color.a_b'])
    assert.deepEqual(button.seeAlso, ['Icon', 'icon-button', 'icon_button'])
    assert.deepEqual(
      inspection.manifest.components.map((entry) => entry.id),
      ['Icon', 'button', 'icon-button', 'icon_button'],
    )
    const collated = ['color.Z', 'color.a-b', 'color.a_b']
      .slice()
      .sort((left, right) => new Intl.Collator('en').compare(left, right))
    assert.notDeepEqual(collated, ['color.Z', 'color.a-b', 'color.a_b'],
      'the fixture must distinguish the two orders, or it pins nothing')
  })

  test('packaged files are listed in code-unit order of their package path', async () => {
    const root = await writeTree(await scratch(), treeFor())
    const inspection = await inspectHandoff({ root })
    const paths = inspection.manifest.files.map((file) => file.path)
    assert.deepEqual(paths, [...paths].sort(byCodeUnit))
    assert.ok(paths.length > 1)
  })
})
