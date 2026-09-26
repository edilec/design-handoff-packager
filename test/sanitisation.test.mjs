/**
 * Nothing untrusted reaches output carrying a character that forges or hides a
 * line, and nothing untrusted costs the report.
 *
 * Four tools in this catalog stripped C0 and the line separators and let the
 * C1 range through; one sanitised its evidence field carefully and let an
 * identifier forge whole lines. So the assertion here walks the WHOLE report
 * and the WHOLE manifest rather than checking the field a developer
 * remembered, and every class arrives through a different door.
 */

import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'

import { excerpt, hasForbiddenCharacter, inspectHandoff, isRenderableText, safeString } from '../src/index.mjs'
import { cleanup, json, planFor, runCli, scratch, treeFor, writeTree } from './support.mjs'

after(cleanup)

const CLASSES = [
  ['C0 (a bare newline forges a line in the human summary)', String.fromCharCode(10)],
  ['C0 (ESC opens a terminal escape sequence)', String.fromCharCode(27)],
  ['DEL', String.fromCharCode(127)],
  ['C1 NEL, which breaks a line with no ESC in front of it', String.fromCharCode(0x85)],
  ['C1 CSI, the 8-bit control sequence introducer', String.fromCharCode(0x9b)],
  ['U+2028 LINE SEPARATOR', String.fromCharCode(0x2028)],
  ['U+2029 PARAGRAPH SEPARATOR', String.fromCharCode(0x2029)],
  ['U+200E LEFT-TO-RIGHT MARK', String.fromCharCode(0x200e)],
  ['U+202E RIGHT-TO-LEFT OVERRIDE, which reverses what is displayed after it', String.fromCharCode(0x202e)],
  ['U+2066 LEFT-TO-RIGHT ISOLATE', String.fromCharCode(0x2066)],
]

function everyString(value, visit, path = '') {
  if (typeof value === 'string') visit(value, path)
  else if (Array.isArray(value)) value.forEach((entry, index) => everyString(entry, visit, path + '/' + index))
  else if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      visit(key, path + '/<key>')
      everyString(entry, visit, path + '/' + key)
    }
  }
}

describe('every class is stripped, whichever door it arrives through', () => {
  for (const [label, character] of CLASSES) {
    test('through the package name, which is an identifier: ' + label, async () => {
      const root = await writeTree(await scratch(), treeFor(planFor({
        package: { name: 'ui' + character + 'kit', version: '1.0.0' },
      })))
      const inspection = await inspectHandoff({ root })
      // The assertion looks for the CHARACTER, not for what the tool's own
      // detector calls forbidden. Asking the tool whether it stripped the class
      // it defines is a guard that moves when the class moves: narrowing the
      // class narrows the oracle with it, and the test stays green. Measured,
      // not imagined -- removing the C1 range from this package left the whole
      // suite passing while U+0085 reached stdout intact.
      for (const document of [inspection.report, inspection.manifest ?? {}]) {
        everyString(document, (text, path) => {
          assert.ok(!text.includes(character), path + ' carried ' + label)
        })
      }
    })

    test('through a note link target, which is an excerpt: ' + label, async () => {
      const root = await writeTree(await scratch(), treeFor(planFor(), {
        'notes/button.md': '[x](https://example.invalid/' + character + 'path)' + String.fromCharCode(10),
      }))
      const inspection = await inspectHandoff({ root })
      everyString(inspection.report, (text, path) => {
        assert.ok(!text.includes(character), path + ' carried ' + label)
      })
    })
  }

  test('and the exported detector agrees, over a report carrying every class at once', async () => {
    const poison = CLASSES.map(([, character]) => character).join('x')
    const root = await writeTree(await scratch(), treeFor(planFor({
      package: { name: 'ui' + poison + 'kit', version: '1.0.0' },
    })))
    const inspection = await inspectHandoff({ root })
    everyString(inspection.report, (text, path) => {
      assert.ok(!hasForbiddenCharacter(text), path)
    })
  })

  test('through a component title, which reaches the manifest and not only the report', async () => {
    const base = planFor()
    const marker = String.fromCharCode(0x202e)
    const root = await writeTree(await scratch(), treeFor(planFor({
      components: [{ ...base.components[0], title: 'But' + marker + 'ton' }],
    })))
    const inspection = await inspectHandoff({ root })
    assert.equal(inspection.report.status, 'pass')
    // Replaced by a space rather than deleted: deleting would silently join
    // two words into one, which is its own way of changing what a reader sees.
    assert.equal(inspection.manifest.components[0].title, 'But ton')
  })
})

describe('an identifier that would render as nothing is refused, not sanitised', () => {
  test('because trim() removes ECMAScript whitespace only', () => {
    // The sibling bug: `value.trim().length > 0` passes for a string of
    // U+0001 or U+200E that then renders EMPTY. Validate what you RENDER.
    for (const character of [String.fromCharCode(1), String.fromCharCode(0x200e), String.fromCharCode(0x2066)]) {
      const text = character.repeat(5)
      assert.equal(text.trim().length, 5, 'trim leaves this alone, which is the whole point')
      assert.equal(isRenderableText(text), false)
      assert.equal(excerpt(text), '')
    }
  })

  test('a plan whose package name renders as nothing fails the schema', async () => {
    const root = await writeTree(await scratch(), treeFor(planFor({
      package: { name: String.fromCharCode(0x200e).repeat(4), version: '1.0.0' },
    })))
    const report = (await inspectHandoff({ root })).report
    assert.equal(report.status, 'fail')
    assert.ok(report.findings.some((finding) => finding.ruleId === 'plan-schema-invalid'))
  })

  test('a token key that no dotted citation could name is reported', async () => {
    const root = await writeTree(await scratch(), treeFor(planFor({
      components: [{ ...planFor().components[0], tokensUsed: [] }],
    }), {
      'tokens/color.json': json({
        color: { brand: { primary: { $value: '#1' } }, 'has.a.dot': { $value: '#2' } },
      }),
    }))
    const report = (await inspectHandoff({ root })).report
    const finding = report.findings.find((entry) => entry.ruleId === 'token-name-unusable')
    assert.ok(finding, 'a key that cannot be cited must be reported, not silently renamed')
    assert.equal(report.status, 'fail', 'nothing cites a token here, so the only finding is the unusable key')
  })
})

describe('a path is recorded verbatim in the manifest, so it is refused rather than cleaned', () => {
  for (const [label, character] of CLASSES) {
    test(label + ' in a path segment is refused', async () => {
      const base = planFor()
      const name = 'notes/a' + character + 'b.md'
      const root = await writeTree(await scratch(), treeFor(planFor({
        components: [{ ...base.components[0], notes: name }],
      }), { [name]: '# note' + String.fromCharCode(10) }))
      const inspection = await inspectHandoff({ root })
      assert.equal(inspection.report.status, 'fail')
      assert.ok(inspection.report.findings.some((finding) => finding.ruleId === 'plan-schema-invalid'))
      // And nothing carrying it reached output by either route.
      everyString(inspection.report, (text, path) => {
        assert.ok(!text.includes(character), path + ' carried ' + label)
      })
      assert.equal(inspection.manifest, null)
    })
  }

  test('an ordinary path with a space is still accepted', async () => {
    const base = planFor()
    const root = await writeTree(await scratch(), treeFor(planFor({
      components: [{ ...base.components[0], notes: 'notes/a b.md' }],
    }), { 'notes/a b.md': '# note' + String.fromCharCode(10) }))
    const inspection = await inspectHandoff({ root })
    assert.equal(inspection.report.status, 'pass')
    assert.equal(inspection.manifest.components[0].notes, 'components/button/notes.md')
  })
})

describe('a value that cannot be stringified never costs the report', () => {
  test('String() throws on it, and the tool still answers', () => {
    const poison = { toString: {} }
    assert.throws(() => String(poison), /Cannot convert object to primitive value/)
    assert.equal(safeString(poison), '[object]')
    assert.equal(safeString([1, 2]), '1,2')
    assert.equal(excerpt(poison), '[object]')
  })

  test('a poisoned leaf yields a report on stdout, not an empty stream', async () => {
    const plan = planFor()
    plan.package.name = { toString: {} }
    const root = await writeTree(await scratch(), treeFor(plan))
    const result = runCli(['--root', root, '--json'])
    assert.notEqual(result.stdout, '', 'stdout must carry a report, not be empty')
    assert.ok(!result.stderr.includes('Cannot convert object to primitive value'), result.stderr)
    const report = JSON.parse(result.stdout)
    assert.equal(report.status, 'fail')
    assert.ok(report.findings.some((finding) => finding.ruleId === 'plan-schema-invalid'))
  })

  test('a poisoned leaf deep inside a component yields a report too', async () => {
    const plan = planFor()
    plan.components[0].states[0].evidence = { toString: {} }
    const root = await writeTree(await scratch(), treeFor(plan))
    const result = runCli(['--root', root, '--json'])
    assert.notEqual(result.stdout, '')
    assert.ok(!result.stderr.includes('Cannot convert object to primitive value'), result.stderr)
    assert.equal(JSON.parse(result.stdout).status, 'fail')
  })

  test('a symbol, which String() also refuses, does not throw either', () => {
    // A Symbol has its own String() behaviour, so it is not the poison case;
    // what matters is that the boundary never throws for it.
    assert.doesNotThrow(() => safeString(Symbol('x')))
    assert.equal(excerpt(Symbol('a b')), 'Symbol(a b)')
  })
})

describe('untrusted content is never echoed where it could read as instruction', () => {
  test('a rejected value is described by its shape, never reproduced', async () => {
    const plan = planFor()
    plan.components[0].id = 'AKIAIOSFODNN7EXAMPLE/../../etc'
    const root = await writeTree(await scratch(), treeFor(plan))
    const report = (await inspectHandoff({ root })).report
    const text = JSON.stringify(report)
    assert.ok(!text.includes('AKIAIOSFODNN7EXAMPLE'), 'the refused value must not be reproduced')
    assert.match(text, /a string of 30 character\(s\)/)
  })
})
