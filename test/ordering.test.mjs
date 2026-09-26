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
import { resolve } from 'node:path'

import { RULE_SEVERITY, byCodeUnit, inspectHandoff, writeHandoffPackage } from '../src/index.mjs'
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

/**
 * Every ordering call site, one at a time.
 *
 * Replacing the whole comparator was already caught. That is not the drift
 * that happens: what happens is one `.sort()` at one site quietly becoming
 * locale-aware while the comparator stays right. Substituting a collator at
 * each site in turn left 12 of 18 with the suite green, so each of the sites
 * below now has an input that the two orders genuinely disagree about.
 *
 * The disagreements used here, measured rather than assumed:
 *
 *   `Z` before `a` by code unit (0x5A, 0x61), after it under collation
 *   `a-b` before `a_b` by code unit (0x2D, 0x5F), after it under collation
 */
const COLLATOR = new Intl.Collator('en')

/** Fail loudly when a fixture cannot tell the two orders apart. */
function distinguishing(values, label) {
  const collated = [...values].sort((left, right) => COLLATOR.compare(left, right))
  assert.notDeepEqual(collated, values, `${label}: the fixture must distinguish the two orders, or it pins nothing`)
  return values
}

describe('each ordering call site, with an input the two orders disagree about', () => {
  test('the pointer key of the finding sort', async () => {
    // An unknown key in the plan is reported at a pointer built from the key
    // itself, so two of them tie on file, rule and message and are separated
    // by pointer alone.
    const root = await writeTree(await scratch(), treeFor(planFor({ Zebra: 1, apple: 2 })))
    const report = (await inspectHandoff({ root })).report
    const pointers = report.findings
      .filter((finding) => finding.ruleId === 'plan-schema-invalid')
      .map((finding) => finding.location.pointer)
    assert.deepEqual(pointers, distinguishing(['/Zebra', '/apple'], 'pointer'))
  })

  test('the message key of the finding sort', async () => {
    // Two broken links on one line of one note: same file, same pointer, same
    // rule. Only the file name inside the message separates them.
    const root = await writeTree(await scratch(), treeFor(planFor(), {
      'notes/button.md': '[one](./Zed.md) and [two](./apple.md)' + String.fromCharCode(10),
    }))
    const report = (await inspectHandoff({ root })).report
    const found = report.findings.filter((finding) => finding.ruleId === 'note-link-unresolved')
    assert.equal(found.length, 2)
    assert.equal(found[0].location.pointer, found[1].location.pointer, 'the fixture must tie on pointer')
    assert.match(found[0].message, /notes\/Zed\.md/)
    assert.match(found[1].message, /notes\/apple\.md/)
    distinguishing(['notes/Zed.md', 'notes/apple.md'], 'message')
  })

  test('the evidence key of the finding sort', async () => {
    // Two external links on one line carry one fixed sentence, so they tie on
    // file, pointer, rule AND message. Only evidence is left.
    const root = await writeTree(await scratch(), treeFor(planFor(), {
      'notes/button.md': '[z](https://Z.invalid/) and [a](https://a.invalid/)' + String.fromCharCode(10),
    }))
    const report = (await inspectHandoff({ root })).report
    const found = report.findings.filter((finding) => finding.ruleId === 'note-link-external')
    assert.equal(found.length, 2)
    assert.equal(found[0].message, found[1].message, 'the fixture must tie on message')
    assert.deepEqual(
      found.map((finding) => finding.evidence),
      distinguishing(['https://Z.invalid/', 'https://a.invalid/'], 'evidence'),
    )
  })

  test('the package file list, the token list, the state list and the input set', async () => {
    const base = planFor()
    const states = [
      ...base.components[0].states,
      { name: 'Zoom', evidence: 'evidence/button-zoom.json' },
      { name: 'always', evidence: 'evidence/button-always.json' },
    ]
    const plan = planFor({
      tokens: [
        { id: 'Zed', source: 'tokens/Zed.json' },
        { id: 'accent', source: 'tokens/accent.json' },
      ],
      components: [
        { ...base.components[0], id: 'Zoom', tokensUsed: [], states },
        { ...base.components[0], id: 'accordion', tokensUsed: [], states },
      ],
    })
    const root = await writeTree(await scratch(), treeFor(plan, {
      'tokens/Zed.json': json({ Zed: { cool: { $value: '#1' } } }),
      'tokens/accent.json': json({ accent: { warm: { $value: '#2' } } }),
      'evidence/button-zoom.json': json({ state: 'Zoom' }),
      'evidence/button-always.json': json({ state: 'always' }),
    }))
    const inspection = await inspectHandoff({ root })
    assert.equal(inspection.report.status, 'pass', JSON.stringify(inspection.report.findings))

    assert.deepEqual(
      inspection.manifest.tokens.map((entry) => entry.id),
      distinguishing(['Zed', 'accent'], 'manifest.tokens'),
    )
    const paths = inspection.manifest.files.map((file) => file.path)
    assert.deepEqual(paths, distinguishing([...paths], 'manifest.files'))
    assert.deepEqual(paths[0], 'components/Zoom/contract.json')
    assert.deepEqual(
      inspection.manifest.components[0].states.map((state) => state.name),
      distinguishing(['Zoom', 'always', 'default', 'disabled'], 'component states'),
    )
    assert.deepEqual(inspection.inputs, distinguishing([...inspection.inputs], 'the input set'))

    const out = resolve(await scratch('dhp-out-'), 'package')
    const written = await writeHandoffPackage(inspection, { out })
    assert.deepEqual(written.written, distinguishing([...written.written], 'the written list'))
  })

  test('the rejected-name list of a token document', async () => {
    const root = await writeTree(await scratch(), treeFor(planFor(), {
      'tokens/color.json': json({
        color: { brand: { primary: { $value: '#1' } } },
        'Z.x': { $value: '#2' },
        'a.x': { $value: '#3' },
      }),
    }))
    const report = (await inspectHandoff({ root })).report
    const finding = report.findings.find((entry) => entry.ruleId === 'token-name-unusable')
    assert.equal(finding.evidence, distinguishing(['Z.x', 'a.x'], 'rejected names').join(', '))
  })

  test('the walk order of a token document, which decides WHICH names are kept', async () => {
    // At most ten unusable keys are reported, so the walk order decides which
    // ten. Under collation the two `Z` keys fall outside the ten and the
    // evidence names a different set.
    const document = { color: { brand: { primary: { $value: '#1' } } }, 'Z1.x': { $value: '#0' }, 'Z2.x': { $value: '#0' } }
    for (let index = 1; index <= 10; index += 1) document[`a${index}.x`] = { $value: '#0' }
    const root = await writeTree(await scratch(), treeFor(planFor(), { 'tokens/color.json': json(document) }))
    const report = (await inspectHandoff({ root })).report
    const finding = report.findings.find((entry) => entry.ruleId === 'token-name-unusable')
    const kept = finding.evidence.split(', ')
    assert.equal(kept.length, 10)
    assert.ok(kept.includes('Z1.x') && kept.includes('Z2.x'),
      'the two keys code-unit order keeps are missing, so the walk is collating: ' + finding.evidence)
    const collatedTen = Object.keys(document)
      .filter((key) => key.includes('.'))
      .sort((left, right) => COLLATOR.compare(left, right))
      .slice(0, 10)
    assert.notDeepEqual(collatedTen.slice().sort(byCodeUnit), kept,
      'the fixture must distinguish the two orders, or it pins nothing')
  })

  test('the rule-id key of the finding sort is an equivalent site, and this says why', () => {
    // Substituting a collator at the `ruleId` comparison changes nothing this
    // tool can emit, because the rule ids are a frozen set and no two of them
    // order differently under collation. That is a measurement, not a hope:
    // if a future rule id breaks it, this fails and the site needs a fixture.
    const ids = Object.keys(RULE_SEVERITY)
    assert.ok(ids.length >= 30)
    const disagreements = []
    for (let left = 0; left < ids.length; left += 1) {
      for (let right = left + 1; right < ids.length; right += 1) {
        const byUnit = byCodeUnit(ids[left], ids[right])
        const byCollation = Math.sign(COLLATOR.compare(ids[left], ids[right]))
        if (byUnit !== byCollation) disagreements.push([ids[left], ids[right]])
      }
    }
    assert.deepEqual(disagreements, [],
      'these rule ids now order differently under collation, so the ruleId sort site needs a real fixture')
  })
})
