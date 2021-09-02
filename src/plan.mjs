/**
 * The handoff plan: what it may say, and what it may not.
 *
 * A plan is an ordinary untrusted document. Every field is checked before it
 * is used, and a field that fails is described by its shape rather than
 * reproduced -- the pointer on the finding already says where to look.
 *
 * Unknown keys are refused at every level. A one-character typo in
 * `requiredStates` would otherwise turn a real failure into a green run, which
 * is a defect this catalog has already paid for.
 */

import { describeValue, isIdentifier, isRenderableText, parseInstant, pointer } from './text.mjs'

const MAX_PATH_LENGTH = 200
const MAX_TOKEN_NAME_LENGTH = 120
const MAX_STORY_LENGTH = 400

const PLAN_KEYS = Object.freeze([
  'schemaVersion', 'package', 'requiredStates', 'evidenceMaxAgeDays', 'tokens', 'components',
])
const PACKAGE_KEYS = Object.freeze(['name', 'version'])
const TOKEN_DOCUMENT_KEYS = Object.freeze(['id', 'source'])
const COMPONENT_KEYS = Object.freeze([
  'id', 'title', 'contract', 'notes', 'story', 'tokensUsed', 'seeAlso', 'states',
])
const STATE_KEYS = Object.freeze(['name', 'evidence', 'capturedAt'])

/** A token name as a component may cite it: dot-separated, no path characters. */
const TOKEN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** Schemes a story link may carry. Neither is ever fetched; see the README. */
const EXTERNAL_SCHEME = /^[a-z][a-z0-9+.-]*:/i

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/**
 * A path a plan may name, and why each refusal is here.
 *
 * Lexical checks are not confinement -- a symlink inside the root resolves out
 * of the tree without ever spelling a traversal, and that is settled later by
 * `realpath`. These checks are about something else: a path that is absolute,
 * or that climbs, or that uses a backslash, is a path whose meaning changes
 * between machines, and a handoff package that means different things on
 * different machines is the defect this tool exists to prevent.
 */
export function validateRelativePath(value) {
  if (typeof value !== 'string') return `must be a string; found ${describeValue(value)}`
  if (value.length === 0) return 'must not be empty'
  if (value.length > MAX_PATH_LENGTH) return `must be at most ${MAX_PATH_LENGTH} characters`
  if (value.includes('\\')) return 'must use "/" as its separator, never a backslash'
  if (value.startsWith('/')) return 'must be relative to the root, not absolute'
  if (/^[A-Za-z]:/.test(value)) return 'must be relative to the root, not a drive-qualified path'
  const segments = value.split('/')
  for (const segment of segments) {
    if (segment === '') return 'must not contain an empty path segment'
    if (segment === '.' || segment === '..') return 'must not contain a "." or ".." segment'
    if (!isRenderableText(segment, MAX_PATH_LENGTH)) {
      return 'must not contain a segment that is invisible or carries a control character'
    }
  }
  return null
}

function checkKeys(record, allowed, at, problems, what) {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      problems.push({ pointer: pointer(...at, key), message: `${what} has an unknown key` })
    }
  }
}

function takePath(record, key, at, problems, required) {
  const value = record[key]
  if (value === undefined) {
    if (required) problems.push({ pointer: pointer(...at, key), message: `"${key}" is required` })
    return null
  }
  const problem = validateRelativePath(value)
  if (problem !== null) {
    problems.push({ pointer: pointer(...at, key), message: `"${key}" ${problem}` })
    return null
  }
  return value
}

function takeStates(raw, at, problems) {
  if (!Array.isArray(raw)) {
    problems.push({ pointer: pointer(...at, 'states'), message: `"states" must be an array; found ${describeValue(raw)}` })
    return []
  }
  const states = []
  raw.forEach((entry, index) => {
    const where = [...at, 'states', String(index)]
    if (!isRecord(entry)) {
      problems.push({ pointer: pointer(...where), message: `a state must be an object; found ${describeValue(entry)}` })
      return
    }
    checkKeys(entry, STATE_KEYS, where, problems, 'a state')
    let name = null
    if (isIdentifier(entry.name)) name = entry.name
    else {
      problems.push({
        pointer: pointer(...where, 'name'),
        message: `"name" must be an identifier of letters, digits, ".", "-" or "_" starting with a letter or digit; found ${describeValue(entry.name)}`,
      })
    }
    const evidence = takePath(entry, 'evidence', where, problems, true)
    let capturedAt = null
    let capturedAtText = null
    if (entry.capturedAt !== undefined) {
      capturedAt = parseInstant(entry.capturedAt)
      if (capturedAt !== null) capturedAtText = entry.capturedAt
      if (capturedAt === null) {
        problems.push({
          pointer: pointer(...where, 'capturedAt'),
          message: `"capturedAt" must be an ISO-8601 UTC instant such as 2026-01-31T09:00:00Z; found ${describeValue(entry.capturedAt)}`,
        })
      }
    }
    if (name === null || evidence === null) return
    states.push({ name, evidence, capturedAt, capturedAtText, pointer: pointer(...where) })
  })
  return states
}

function takeStringList(record, key, at, problems, { limitLength, validate, what }) {
  const raw = record[key]
  if (raw === undefined) return []
  if (!Array.isArray(raw)) {
    problems.push({ pointer: pointer(...at, key), message: `"${key}" must be an array; found ${describeValue(raw)}` })
    return []
  }
  const values = []
  raw.forEach((entry, index) => {
    if (typeof entry !== 'string' || entry.length > limitLength || !validate(entry)) {
      problems.push({ pointer: pointer(...at, key, String(index)), message: `${what}; found ${describeValue(entry)}` })
      return
    }
    values.push({ value: entry, pointer: pointer(...at, key, String(index)) })
  })
  return values
}

/**
 * Validate a parsed plan document.
 *
 * Returns `{plan, problems}`. `plan` is null only when the document is not an
 * object at all; otherwise it carries everything that validated, so one bad
 * component does not hide the other nineteen. Every problem is reported --
 * stopping at the first one turns a five-minute fix into five runs.
 */
export function validatePlan(document) {
  const problems = []
  if (!isRecord(document)) {
    return { plan: null, problems: [{ pointer: '', message: `the plan must be a JSON object; found ${describeValue(document)}` }] }
  }
  checkKeys(document, PLAN_KEYS, [], problems, 'the plan')

  if (document.schemaVersion !== '1') {
    problems.push({
      pointer: pointer('schemaVersion'),
      message: `"schemaVersion" must be the string "1"; found ${describeValue(document.schemaVersion)}`,
    })
  }

  let handoffPackage = null
  if (!isRecord(document.package)) {
    problems.push({ pointer: pointer('package'), message: `"package" must be an object; found ${describeValue(document.package)}` })
  } else {
    checkKeys(document.package, PACKAGE_KEYS, ['package'], problems, '"package"')
    const name = isRenderableText(document.package.name, 120) ? document.package.name : null
    const version = isRenderableText(document.package.version, 60) ? document.package.version : null
    if (name === null) {
      problems.push({ pointer: pointer('package', 'name'), message: `"name" must be text that is still visible once control characters are removed; found ${describeValue(document.package.name)}` })
    }
    if (version === null) {
      problems.push({ pointer: pointer('package', 'version'), message: `"version" must be text that is still visible once control characters are removed; found ${describeValue(document.package.version)}` })
    }
    if (name !== null && version !== null) handoffPackage = { name, version }
  }

  const requiredStates = []
  if (!Array.isArray(document.requiredStates) || document.requiredStates.length === 0) {
    problems.push({
      pointer: pointer('requiredStates'),
      message: `"requiredStates" must be a non-empty array of state names; found ${describeValue(document.requiredStates)}`,
    })
  } else {
    const seen = new Set()
    document.requiredStates.forEach((entry, index) => {
      if (!isIdentifier(entry)) {
        problems.push({ pointer: pointer('requiredStates', String(index)), message: `a required state must be an identifier; found ${describeValue(entry)}` })
        return
      }
      if (seen.has(entry)) {
        problems.push({ pointer: pointer('requiredStates', String(index)), message: 'a required state is listed twice' })
        return
      }
      seen.add(entry)
      requiredStates.push(entry)
    })
  }

  let evidenceMaxAgeDays = null
  if (document.evidenceMaxAgeDays !== undefined) {
    if (!Number.isInteger(document.evidenceMaxAgeDays) || document.evidenceMaxAgeDays < 1) {
      problems.push({
        pointer: pointer('evidenceMaxAgeDays'),
        message: `"evidenceMaxAgeDays" must be a positive integer; found ${describeValue(document.evidenceMaxAgeDays)}`,
      })
    } else {
      evidenceMaxAgeDays = document.evidenceMaxAgeDays
    }
  }

  const tokens = []
  if (document.tokens !== undefined) {
    if (!Array.isArray(document.tokens)) {
      problems.push({ pointer: pointer('tokens'), message: `"tokens" must be an array; found ${describeValue(document.tokens)}` })
    } else {
      document.tokens.forEach((entry, index) => {
        const where = ['tokens', String(index)]
        if (!isRecord(entry)) {
          problems.push({ pointer: pointer(...where), message: `a token document must be an object; found ${describeValue(entry)}` })
          return
        }
        checkKeys(entry, TOKEN_DOCUMENT_KEYS, where, problems, 'a token document')
        const id = isIdentifier(entry.id) ? entry.id : null
        if (id === null) {
          problems.push({ pointer: pointer(...where, 'id'), message: `"id" must be an identifier; found ${describeValue(entry.id)}` })
        }
        const source = takePath(entry, 'source', where, problems, true)
        if (id === null || source === null) return
        tokens.push({ id, source, pointer: pointer(...where) })
      })
    }
  }

  const components = []
  if (!Array.isArray(document.components)) {
    problems.push({ pointer: pointer('components'), message: `"components" must be an array; found ${describeValue(document.components)}` })
  } else {
    document.components.forEach((entry, index) => {
      const where = ['components', String(index)]
      if (!isRecord(entry)) {
        problems.push({ pointer: pointer(...where), message: `a component must be an object; found ${describeValue(entry)}` })
        return
      }
      checkKeys(entry, COMPONENT_KEYS, where, problems, 'a component')
      const id = isIdentifier(entry.id) ? entry.id : null
      if (id === null) {
        problems.push({
          pointer: pointer(...where, 'id'),
          message: `"id" must be an identifier of letters, digits, ".", "-" or "_" starting with a letter or digit, because it becomes a directory name in the package; found ${describeValue(entry.id)}`,
        })
      }
      let title = null
      if (entry.title !== undefined) {
        if (isRenderableText(entry.title, 160)) title = entry.title
        else problems.push({ pointer: pointer(...where, 'title'), message: `"title" must be text that is still visible once control characters are removed; found ${describeValue(entry.title)}` })
      }
      const contract = takePath(entry, 'contract', where, problems, true)
      const notes = takePath(entry, 'notes', where, problems, false)

      let story = null
      if (entry.story !== undefined) {
        if (!isRenderableText(entry.story, MAX_STORY_LENGTH)) {
          problems.push({ pointer: pointer(...where, 'story'), message: `"story" must be text that is still visible once control characters are removed; found ${describeValue(entry.story)}` })
        } else if (EXTERNAL_SCHEME.test(entry.story)) {
          story = { kind: 'external', value: entry.story, pointer: pointer(...where, 'story') }
        } else {
          const problem = validateRelativePath(entry.story)
          if (problem !== null) problems.push({ pointer: pointer(...where, 'story'), message: `"story" ${problem}, or must carry a scheme such as https:` })
          else story = { kind: 'internal', value: entry.story, pointer: pointer(...where, 'story') }
        }
      }

      const tokensUsed = takeStringList(entry, 'tokensUsed', where, problems, {
        limitLength: MAX_TOKEN_NAME_LENGTH,
        validate: (value) => TOKEN_NAME.test(value),
        what: 'a token reference must be a dot-separated name such as color.brand.primary',
      })
      const seeAlso = takeStringList(entry, 'seeAlso', where, problems, {
        limitLength: 64,
        validate: isIdentifier,
        what: 'a cross reference must be a component identifier',
      })
      const states = takeStates(entry.states, where, problems)
      if (entry.states === undefined) {
        problems.push({ pointer: pointer(...where, 'states'), message: '"states" is required' })
      }

      if (id === null || contract === null) return
      components.push({ id, title, contract, notes, story, tokensUsed, seeAlso, states, pointer: pointer(...where) })
    })
  }

  return {
    plan: { package: handoffPackage, requiredStates, evidenceMaxAgeDays, tokens, components },
    problems,
  }
}
