/**
 * The plan schema, on its own.
 *
 * Every refusal here exists because the value would otherwise become a path
 * segment, a report line, or a silent no-op.
 */

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import { hasForbiddenCharacter, validatePlan, validateRelativePath } from '../src/index.mjs'

function planWith(overrides) {
  return {
    schemaVersion: '1',
    package: { name: 'ui', version: '1.0.0' },
    requiredStates: ['default'],
    components: [{
      id: 'button',
      contract: 'c/b.json',
      states: [{ name: 'default', evidence: 'e/b.json' }],
    }],
    ...overrides,
  }
}

function problemsFor(plan) {
  return validatePlan(plan).problems.map((problem) => problem.pointer + ' ' + problem.message)
}

describe('a well-formed plan', () => {
  test('has no problems', () => {
    assert.deepEqual(validatePlan(planWith({})).problems, [])
  })

  test('keeps the declared order of requiredStates', () => {
    const { plan } = validatePlan(planWith({ requiredStates: ['hover', 'default'] }))
    assert.deepEqual(plan.requiredStates, ['hover', 'default'])
  })
})

describe('unknown keys are refused at every level', () => {
  const cases = [
    ['the plan', planWith({ extra: 1 }), '/extra'],
    ['package', planWith({ package: { name: 'a', version: '1', extra: 1 } }), '/package/extra'],
    ['a component', planWith({
      components: [{ ...planWith({}).components[0], extra: 1 }],
    }), '/components/0/extra'],
    ['a state', planWith({
      components: [{ ...planWith({}).components[0], states: [{ name: 'default', evidence: 'e/b.json', extra: 1 }] }],
    }), '/components/0/states/0/extra'],
    ['a token document', planWith({ tokens: [{ id: 'c', source: 't.json', extra: 1 }] }), '/tokens/0/extra'],
  ]
  for (const [what, plan, pointer] of cases) {
    test(what, () => {
      const problems = problemsFor(plan)
      assert.ok(problems.some((problem) => problem.startsWith(pointer + ' ')), problems.join(' | '))
    })
  }
})

describe('required fields', () => {
  const cases = [
    ['schemaVersion must be "1"', planWith({ schemaVersion: 1 }), '/schemaVersion'],
    ['package is required', planWith({ package: undefined }), '/package'],
    ['requiredStates must be non-empty', planWith({ requiredStates: [] }), '/requiredStates'],
    ['requiredStates may not repeat', planWith({ requiredStates: ['a', 'a'] }), '/requiredStates/1'],
    ['components must be an array', planWith({ components: {} }), '/components'],
    ['a component needs an id', planWith({ components: [{ contract: 'c.json', states: [] }] }), '/components/0/id'],
    ['a component needs a contract', planWith({ components: [{ id: 'a', states: [] }] }), '/components/0/contract'],
    ['a component needs states', planWith({ components: [{ id: 'a', contract: 'c.json' }] }), '/components/0/states'],
    ['a state needs evidence', planWith({
      components: [{ id: 'a', contract: 'c.json', states: [{ name: 'default' }] }],
    }), '/components/0/states/0/evidence'],
    ['evidenceMaxAgeDays must be a positive integer', planWith({ evidenceMaxAgeDays: 0 }), '/evidenceMaxAgeDays'],
    ['capturedAt must be a real UTC instant', planWith({
      components: [{ id: 'a', contract: 'c.json', states: [{ name: 'default', evidence: 'e.json', capturedAt: '2026-02-31T00:00:00Z' }] }],
    }), '/components/0/states/0/capturedAt'],
  ]
  for (const [what, plan, pointer] of cases) {
    test(what, () => {
      const problems = problemsFor(plan)
      assert.ok(problems.some((problem) => problem.startsWith(pointer + ' ')), problems.join(' | '))
    })
  }
})

describe('identifiers that would become path segments', () => {
  const refused = ['', '.', '..', '.hidden', 'a/b', 'a b', 'x'.repeat(65), 'a' + String.fromCharCode(10) + 'b']
  for (const id of refused) {
    test(JSON.stringify(id) + ' is refused as a component id', () => {
      const problems = problemsFor(planWith({ components: [{ id, contract: 'c.json', states: [] }] }))
      assert.ok(problems.some((problem) => problem.startsWith('/components/0/id ')), problems.join(' | '))
    })
  }

  test('an ordinary id is accepted', () => {
    for (const id of ['button', 'Button', 'icon-button', 'icon_button', 'v2.button', '2xl']) {
      const { problems } = validatePlan(planWith({
        components: [{ id, contract: 'c.json', states: [{ name: 'default', evidence: 'e.json' }] }],
      }))
      assert.deepEqual(problems, [], id)
    }
  })
})

describe('validateRelativePath', () => {
  const refused = [
    ['/etc/passwd', /not absolute/],
    ['C:/windows', /drive-qualified/],
    ['a\\b.json', /backslash/],
    ['../outside.json', /".." segment/],
    ['a/./b.json', /".." segment/],
    ['a//b.json', /empty path segment/],
    ['', /must not be empty/],
    ['x'.repeat(300), /at most 200/],
    [42, /must be a string/],
  ]
  for (const [value, expected] of refused) {
    test(JSON.stringify(value) + ' is refused', () => {
      assert.match(validateRelativePath(value), expected)
    })
  }

  test('a segment that renders as nothing is refused', () => {
    assert.match(validateRelativePath('a/' + String.fromCharCode(0x200e) + '/b.json'), /invisible/)
  })

  /**
   * The same refusal, on characters the control-character check does NOT
   * catch. U+200E above is in both classes, so that case alone pins the two
   * refusals together and stops telling them apart the moment either message
   * is reworded. A space, a no-break space and an ideographic space are
   * ordinary printable characters a path may contain -- just not as the whole
   * of a segment, which then names a directory whose name reads as nothing.
   */
  for (const [what, segment] of [
    ['a space', ' '],
    ['a no-break space', String.fromCharCode(0x00a0)],
    ['an ideographic space', String.fromCharCode(0x3000)],
  ]) {
    test('a segment that is only ' + what + ' is refused by renderability alone', () => {
      assert.match(validateRelativePath('a/' + segment + '/b.json'), /invisible/)
      assert.match(validateRelativePath(segment), /invisible/)
      assert.equal(hasForbiddenCharacter(segment), false,
        'if the control-character class caught this, the case would not pin the renderability check')
    })
  }

  test('an ordinary relative path is accepted', () => {
    for (const value of ['a.json', 'a/b.json', 'a/b/c-d_e.json', 'a b.json']) {
      assert.equal(validateRelativePath(value), null, value)
    }
  })
})

describe('one bad component does not hide the others', () => {
  test('every problem is reported, not just the first', () => {
    const problems = problemsFor(planWith({
      schemaVersion: '2',
      components: [{ id: 'a/b', contract: 42, states: [] }],
    }))
    assert.ok(problems.length >= 3, problems.join(' | '))
  })

  test('a plan that is not an object at all is refused outright', () => {
    const { plan, problems } = validatePlan([])
    assert.equal(plan, null)
    assert.equal(problems.length, 1)
  })
})
