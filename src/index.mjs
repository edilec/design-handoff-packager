/**
 * design-handoff-packager
 *
 * Reads a handoff plan and the component contracts, design tokens, usage notes
 * and per-state evidence it names, checks that every internal link in it
 * resolves and that every required state has evidence, and writes a portable
 * handoff directory with a manifest.
 *
 * Three properties are structural rather than incidental:
 *
 * 1. **A handoff that does not hold together is not packaged.** The directory
 *    is written only when the check passes. A broken link or a required state
 *    with no evidence fails the run, and nothing is written -- a package whose
 *    manifest points at files that are not there is worse than no package.
 * 2. **Nothing the tool reads is ever written to.** The package goes to a
 *    separate destination, and that destination is refused if it is a link, if
 *    it escapes the directory the caller named, or if it is one of the files
 *    being packaged -- including through a hard link, which shares no path
 *    with the file it names.
 * 3. **The package is reproducible.** Same plan, same sources, byte-identical
 *    manifest on any machine: no clock in the output, no absolute path, no
 *    host detail, no locale-dependent ordering, and fixed names inside the
 *    package so a source file's own name cannot change the result.
 */

import { createHash } from 'node:crypto'
import { readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { posix, relative, resolve, sep } from 'node:path'

import { extractLinks, classifyTarget } from './links.mjs'
import { validatePlan, validateRelativePath } from './plan.mjs'
import { flattenTokens } from './tokens.mjs'
import {
  byCodeUnit,
  decodeUtf8,
  excerpt,
  parseFailureDetail,
  pointer as jsonPointer,
} from './text.mjs'
import {
  DestinationError,
  assertWritableDestination,
  ensureDirectoryWithin,
  prepareOutputRoot,
} from './write-guard.mjs'

export { DestinationError, assertWritableDestination, ensureDirectoryWithin, prepareOutputRoot } from './write-guard.mjs'
export { byCodeUnit, decodeUtf8, excerpt, hasForbiddenCharacter, isIdentifier, isRenderableText, parseFailureDetail, parseInstant, safeString } from './text.mjs'
export { extractLinks, classifyTarget } from './links.mjs'
export { flattenTokens } from './tokens.mjs'
export { validatePlan, validateRelativePath } from './plan.mjs'

export const TOOL_ID = 'design-handoff-packager'
export const REPORT_SCHEMA_VERSION = '1'
export const MANIFEST_SCHEMA_VERSION = '1'
export const DEFAULT_PLAN_NAME = 'handoff.json'
export const MANIFEST_NAME = 'manifest.json'

/**
 * Bounds are part of the contract, not a safety net.
 *
 * A plan and the tree it names are ordinary untrusted input: a generated
 * token file with a million leaves, a note with fifty thousand links, a tree
 * that nests forever. Every limit below is explicit, overridable, and named in
 * the finding when it is reached. Exceeding one produces an `incomplete`
 * report -- never a quietly smaller package, and never a pass.
 *
 * `maxPackageBytes` exists because the package is assembled in memory before
 * anything is written: the bytes that were hashed are the bytes that are
 * copied, so a source file changing under the run cannot produce a manifest
 * that disagrees with the directory beside it.
 */
export const DEFAULT_LIMITS = Object.freeze({
  maxPlanBytes: 262144,
  maxComponents: 400,
  maxStatesPerComponent: 40,
  maxTokenDocuments: 50,
  maxTokensPerDocument: 5000,
  maxTokenDepth: 12,
  maxFileBytes: 1048576,
  maxFiles: 1200,
  maxPackageBytes: 16777216,
  maxNoteLinks: 200,
})

/**
 * The authoritative rule severity table.
 *
 * Severity is the whole difference between a run that fails and one that
 * passes. Spread across three dozen construction sites as a literal it drifts
 * silently, and flipping one rule down to a warning turns a refusal into a
 * green build with every test still passing. Every finding takes its severity
 * from here, an unknown rule id throws, and `docs/handoff-rules.md` is asserted
 * against this table in both directions.
 *
 * The table is a source of truth, not the test. Three declarations agreeing
 * with each other can be edited together; `test/severity-behaviour.test.mjs`
 * drives a real plan through the real entry point instead and asserts the exit
 * code, which cannot be edited at all.
 */
export const RULE_SEVERITY = Object.freeze({
  'cross-reference-unresolved': 'error',
  'duplicate-component-id': 'error',
  'duplicate-state': 'error',
  'id-case-collision': 'error',
  'no-components': 'error',
  'note-link-external': 'info',
  'note-link-unresolved': 'error',
  'note-links-truncated': 'error',
  'plan-invalid-json': 'error',
  'plan-not-utf8': 'error',
  'plan-schema-invalid': 'error',
  'plan-too-large': 'error',
  'plan-unreadable': 'error',
  'root-unreadable': 'error',
  'source-escapes-root': 'error',
  'source-invalid-json': 'error',
  'source-missing': 'error',
  'source-not-a-file': 'error',
  'source-not-utf8': 'error',
  'source-too-large': 'error',
  'source-unreadable': 'error',
  'state-evidence-missing': 'error',
  'state-evidence-stale': 'error',
  'state-evidence-undated': 'error',
  'story-link-external': 'info',
  'story-link-unresolved': 'error',
  'token-document-truncated': 'error',
  'token-document-too-deep': 'error',
  'token-reference-unresolved': 'error',
  'token-references-unchecked': 'error',
  'too-many-components': 'error',
  'too-many-files': 'error',
  'too-many-states': 'error',
  'too-many-token-documents': 'error',
  'package-too-large': 'error',
})

/**
 * What each rule says about the run, which is a different question from how
 * serious it is.
 *
 * - `policy` means the tool obtained its evidence and the plan contradicted
 *   it. A missing file is a policy failure: the tool looked, and it is not
 *   there.
 * - `evidence` means the tool could not obtain the evidence at all. An
 *   unreadable file is NOT an absent one, and reporting it as absence is the
 *   defect this split exists to prevent. Any `evidence` finding makes the run
 *   `incomplete` and exits 2, whatever else was found.
 *
 * Unknown is never a pass, and it is never reported as absence either.
 */
export const RULE_OUTCOME = Object.freeze({
  'cross-reference-unresolved': 'policy',
  'duplicate-component-id': 'policy',
  'duplicate-state': 'policy',
  'id-case-collision': 'policy',
  'no-components': 'policy',
  'note-link-external': 'policy',
  'note-link-unresolved': 'policy',
  'note-links-truncated': 'evidence',
  'plan-invalid-json': 'evidence',
  'plan-not-utf8': 'evidence',
  'plan-schema-invalid': 'policy',
  'plan-too-large': 'evidence',
  'plan-unreadable': 'evidence',
  'root-unreadable': 'evidence',
  'source-escapes-root': 'policy',
  'source-invalid-json': 'evidence',
  'source-missing': 'policy',
  'source-not-a-file': 'policy',
  'source-not-utf8': 'evidence',
  'source-too-large': 'evidence',
  'source-unreadable': 'evidence',
  'state-evidence-missing': 'policy',
  'state-evidence-stale': 'policy',
  'state-evidence-undated': 'policy',
  'story-link-external': 'policy',
  'story-link-unresolved': 'policy',
  'token-document-truncated': 'evidence',
  'token-document-too-deep': 'evidence',
  'token-reference-unresolved': 'policy',
  'token-references-unchecked': 'evidence',
  'too-many-components': 'evidence',
  'too-many-files': 'evidence',
  'too-many-states': 'evidence',
  'too-many-token-documents': 'evidence',
  'package-too-large': 'evidence',
})

const ALLOWED_OPTIONS = Object.freeze(['root', 'plan', 'limits', 'now'])

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function validateLimits(overrides = {}) {
  if (!isRecord(overrides)) throw new TypeError('Limits must be an object')
  const limits = { ...DEFAULT_LIMITS }
  for (const [name, value] of Object.entries(overrides)) {
    if (!Object.hasOwn(DEFAULT_LIMITS, name)) throw new TypeError(`Unknown limit "${name}"`)
    if (!Number.isInteger(value) || value < 1) throw new TypeError(`Limit "${name}" must be a positive integer`)
    limits[name] = value
  }
  return Object.freeze(limits)
}

/** Containment decided on real paths. A lexical prefix check is not confinement. */
export function isInside(root, candidate) {
  if (candidate === root) return true
  return candidate.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)
}

/** Host separators out, POSIX in. A manifest reads the same on every platform. */
function toPosix(value) {
  return value.split(sep).join('/')
}

class Collector {
  constructor() {
    this.findings = []
  }

  add(ruleId, { file, pointer = null, message, evidence = null, suggestion = null }) {
    const severity = RULE_SEVERITY[ruleId]
    if (severity === undefined) throw new TypeError(`Unknown rule id "${ruleId}"`)
    const finding = {
      ruleId,
      severity,
      message: excerpt(message, 400),
      location: pointer === null ? { file: excerpt(file, 240) } : { file: excerpt(file, 240), pointer: excerpt(pointer, 240) },
    }
    if (evidence !== null) finding.evidence = excerpt(evidence)
    if (suggestion !== null) finding.suggestion = excerpt(suggestion, 240)
    this.findings.push(finding)
  }
}

/**
 * The documented sort key, applied by code unit.
 *
 * `message` is the last key rather than a decoration: two unresolved links on
 * the same line of the same note share file, pointer and rule, and without it
 * their order would come from the order the regular expression happened to
 * match -- which is stable here, but stability by accident is what this key
 * exists to replace.
 */
function sortFindings(findings) {
  return findings.sort((left, right) =>
    byCodeUnit(left.location.file, right.location.file)
    || byCodeUnit(left.location.pointer ?? '', right.location.pointer ?? '')
    || byCodeUnit(left.ruleId, right.ruleId)
    || byCodeUnit(left.message, right.message))
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Read one file the plan named.
 *
 * Every path reaches `inputs` BEFORE it is touched, and both spellings of it
 * do: the path as resolved against the root, and the real path once the links
 * are followed. The write guard compares device and inode, and a set that is
 * missing a path cannot protect the file behind it -- one tool in this catalog
 * passed only its primary input and destroyed every other file it read.
 */
async function readSource(context, relativePath, options) {
  const { missingRule = 'source-missing', at, expectJson = false, verifyOnly = false } = options
  const { realRoot, limits, collector, planFile, inputs } = context
  const blamed = at.file ?? planFile
  const candidate = resolve(realRoot, ...relativePath.split('/'))
  inputs.add(candidate)

  let real
  try {
    real = await realpath(candidate)
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
      collector.add(missingRule, {
        file: blamed,
        pointer: at.pointer,
        message: `${at.what} names ${relativePath}, and there is no such file under the root.`,
        suggestion: 'Add the file, or correct the path in the plan.',
      })
      return { ok: false }
    }
    collector.add('source-unreadable', {
      file: blamed,
      pointer: at.pointer,
      message: `${at.what} names ${relativePath}, which could not be resolved: ${error.code ?? 'unknown error'}. An unreadable file is not an absent one, so this run is incomplete rather than failed.`,
    })
    return { ok: false }
  }
  inputs.add(real)

  if (!isInside(realRoot, real)) {
    collector.add('source-escapes-root', {
      file: blamed,
      pointer: at.pointer,
      message: `${at.what} names ${relativePath}, which resolves outside the root. A link on the way there does not widen the root, so nothing outside it is read or packaged.`,
    })
    return { ok: false }
  }

  let info
  try {
    info = await stat(real)
  } catch (error) {
    collector.add('source-unreadable', {
      file: blamed,
      pointer: at.pointer,
      message: `${at.what} names ${relativePath}, which could not be inspected: ${error.code ?? 'unknown error'}.`,
    })
    return { ok: false }
  }
  if (!info.isFile()) {
    collector.add('source-not-a-file', {
      file: blamed,
      pointer: at.pointer,
      message: `${at.what} names ${relativePath}, which exists but is not a regular file.`,
    })
    return { ok: false }
  }
  if (verifyOnly) return { ok: true, bytes: null, text: null, real, relativePath }
  if (info.size > limits.maxFileBytes) {
    collector.add('source-too-large', {
      file: relativePath,
      pointer: at.pointer,
      message: `${relativePath} is ${info.size} bytes, over the maxFileBytes limit of ${limits.maxFileBytes}. It was not read, so nothing is claimed about it.`,
    })
    return { ok: false }
  }

  let bytes
  try {
    bytes = await readFile(real)
  } catch (error) {
    collector.add('source-unreadable', {
      file: relativePath,
      pointer: at.pointer,
      message: `${relativePath} could not be read: ${error.code ?? 'unknown error'}.`,
    })
    return { ok: false }
  }

  const decoded = decodeUtf8(bytes)
  if (!decoded.ok) {
    collector.add('source-not-utf8', {
      file: relativePath,
      pointer: at.pointer,
      message: `${relativePath} is not valid UTF-8, so its content could not be examined.`,
    })
    return { ok: false }
  }

  if (expectJson) {
    try {
      JSON.parse(decoded.text)
    } catch (error) {
      collector.add('source-invalid-json', {
        file: relativePath,
        pointer: at.pointer,
        message: `${relativePath} is not valid JSON: ${parseFailureDetail(error)}.`,
      })
      return { ok: false }
    }
  }

  return { ok: true, bytes, text: decoded.text, real, relativePath }
}

function addFile(context, packagePath, source) {
  const { files, limits, collector, planFile } = context
  if (context.tooManyFiles || context.packageTooLarge) return
  if (files.length >= limits.maxFiles) {
    context.tooManyFiles = true
    collector.add('too-many-files', {
      file: planFile,
      message: `the plan names more than maxFiles (${limits.maxFiles}) files to package, so the package was not assembled.`,
    })
    return
  }
  context.packageBytes += source.bytes.length
  if (context.packageBytes > limits.maxPackageBytes) {
    context.packageTooLarge = true
    collector.add('package-too-large', {
      file: planFile,
      message: `the packaged files exceed maxPackageBytes (${limits.maxPackageBytes}), so the package was not assembled.`,
    })
    return
  }
  files.push({
    path: packagePath,
    source: source.relativePath,
    bytes: source.bytes.length,
    sha256: sha256(source.bytes),
    content: source.bytes,
  })
}

function noteCaseCollision(seen, value, register) {
  const folded = value.toLowerCase()
  if (seen.has(folded) && seen.get(folded) !== value) return seen.get(folded)
  if (register) seen.set(folded, value)
  return null
}

/**
 * Resolve a link written inside a Markdown note, relative to that note.
 *
 * A fragment and a query are stripped before resolving: `./anatomy.md#states`
 * names a file and a place inside it, and the file is the part that has to
 * exist. Percent-escapes are decoded, because `./a%20b.md` and `./a b.md` name
 * the same file and a checker that disagreed with every Markdown renderer
 * would be reporting on a document nobody else sees.
 */
export function resolveNoteTarget(noteRelativePath, target) {
  const withoutFragment = target.split('#')[0].split('?')[0]
  if (withoutFragment === '') return { ok: false, reason: 'empty' }
  let decodedTarget
  try {
    decodedTarget = decodeURIComponent(withoutFragment)
  } catch {
    return { ok: false, reason: 'undecodable' }
  }
  if (decodedTarget.includes('\\')) return { ok: false, reason: 'backslash' }
  if (decodedTarget.startsWith('/')) return { ok: false, reason: 'absolute' }
  const joined = posix.normalize(posix.join(posix.dirname(noteRelativePath), decodedTarget))
  if (joined === '.' || joined.startsWith('../')) return { ok: false, reason: 'escapes-root' }
  const problem = validateRelativePath(joined)
  if (problem !== null) return { ok: false, reason: 'invalid' }
  return { ok: true, path: joined }
}

/**
 * Inspect a handoff plan and assemble the package that would be written.
 *
 * Returns `{report, manifest, files, inputs, planFile}`. `manifest` and
 * `files` are null unless the report passed: a package is assembled only from
 * a plan that holds together, so a caller cannot write a directory whose
 * manifest points at files that were never found.
 */
export async function inspectHandoff(options = {}) {
  if (!isRecord(options)) throw new TypeError('Options must be an object')
  for (const key of Object.keys(options)) {
    if (!ALLOWED_OPTIONS.includes(key)) throw new TypeError(`Unknown option "${key}"`)
  }
  const { root, plan: planOption = DEFAULT_PLAN_NAME, now = Date.now } = options
  if (typeof root !== 'string' || root.trim() === '') throw new TypeError('A root directory is required')
  if (typeof planOption !== 'string' || planOption.trim() === '') throw new TypeError('The plan path must be a non-empty string')
  if (typeof now !== 'function') throw new TypeError('now must be a function returning epoch milliseconds')
  const limits = validateLimits(options.limits ?? {})

  const collector = new Collector()
  const inputs = new Set()

  const rootCandidate = resolve(root)
  inputs.add(rootCandidate)
  let realRoot
  try {
    realRoot = await realpath(rootCandidate)
  } catch (error) {
    collector.add('root-unreadable', {
      file: '.',
      message: `the root ${excerpt(root, 160)} could not be resolved: ${error.code ?? 'unknown error'}.`,
    })
    return finish({ collector, summary: emptySummary(), manifest: null, files: null, inputs, planFile: DEFAULT_PLAN_NAME })
  }
  inputs.add(realRoot)

  const planCandidate = resolve(realRoot, planOption)
  inputs.add(planCandidate)
  let realPlan
  try {
    realPlan = await realpath(planCandidate)
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') {
      collector.add('plan-unreadable', {
        file: toPosix(relative(realRoot, planCandidate)) || planOption,
        message: `the plan could not be resolved: ${error.code ?? 'unknown error'}.`,
      })
      return finish({ collector, summary: emptySummary(), manifest: null, files: null, inputs, planFile: planOption })
    }
    collector.add('plan-unreadable', {
      file: toPosix(relative(realRoot, planCandidate)) || planOption,
      message: 'there is no plan at that path under the root.',
      suggestion: `Create ${DEFAULT_PLAN_NAME} in the root, or pass --plan.`,
    })
    return finish({ collector, summary: emptySummary(), manifest: null, files: null, inputs, planFile: planOption })
  }
  inputs.add(realPlan)
  if (!isInside(realRoot, realPlan)) {
    throw new TypeError('The plan must resolve inside the root, so that every path in the report is relative to it')
  }
  const planFile = toPosix(relative(realRoot, realPlan))

  const context = {
    realRoot, limits, collector, planFile, inputs,
    files: [], packageBytes: 0, tooManyFiles: false, packageTooLarge: false,
  }

  let planInfo
  try {
    planInfo = await stat(realPlan)
  } catch (error) {
    collector.add('plan-unreadable', { file: planFile, message: `the plan could not be inspected: ${error.code ?? 'unknown error'}.` })
    return finish({ collector, summary: emptySummary(), manifest: null, files: null, inputs, planFile })
  }
  if (planInfo.size > limits.maxPlanBytes) {
    collector.add('plan-too-large', {
      file: planFile,
      message: `the plan is ${planInfo.size} bytes, over the maxPlanBytes limit of ${limits.maxPlanBytes}. It was not read.`,
    })
    return finish({ collector, summary: emptySummary(), manifest: null, files: null, inputs, planFile })
  }

  let planBytes
  try {
    planBytes = await readFile(realPlan)
  } catch (error) {
    collector.add('plan-unreadable', { file: planFile, message: `the plan could not be read: ${error.code ?? 'unknown error'}.` })
    return finish({ collector, summary: emptySummary(), manifest: null, files: null, inputs, planFile })
  }
  const decodedPlan = decodeUtf8(planBytes)
  if (!decodedPlan.ok) {
    collector.add('plan-not-utf8', { file: planFile, message: 'the plan is not valid UTF-8, so it was not parsed.' })
    return finish({ collector, summary: emptySummary(), manifest: null, files: null, inputs, planFile })
  }
  let document
  try {
    document = JSON.parse(decodedPlan.text)
  } catch (error) {
    collector.add('plan-invalid-json', { file: planFile, message: `the plan is not valid JSON: ${parseFailureDetail(error)}.` })
    return finish({ collector, summary: emptySummary(), manifest: null, files: null, inputs, planFile })
  }

  const { plan, problems } = validatePlan(document)
  for (const problem of problems) {
    collector.add('plan-schema-invalid', { file: planFile, pointer: problem.pointer, message: problem.message })
  }
  if (plan === null) {
    return finish({ collector, summary: emptySummary(), manifest: null, files: null, inputs, planFile })
  }

  const summary = emptySummary()

  // --- token documents -------------------------------------------------
  const tokenNames = new Set()
  let tokenSetComplete = true
  const tokenDocuments = []
  const tokenIdCase = new Map()

  if (plan.tokens.length > limits.maxTokenDocuments) {
    tokenSetComplete = false
    collector.add('too-many-token-documents', {
      file: planFile,
      pointer: jsonPointer('tokens'),
      message: `the plan names ${plan.tokens.length} token documents, over the maxTokenDocuments limit of ${limits.maxTokenDocuments}.`,
    })
  } else {
    for (const document_ of plan.tokens) {
      const collision = noteCaseCollision(tokenIdCase, document_.id, true)
      if (collision !== null) {
        collector.add('id-case-collision', {
          file: planFile,
          pointer: `${document_.pointer}/id`,
          message: `token document "${document_.id}" and "${collision}" differ only in case, so they would be one file on a case-insensitive filesystem and the package would not be reproducible across machines.`,
        })
        tokenSetComplete = false
        continue
      }
      const source = await readSource(context, document_.source, {
        at: { pointer: `${document_.pointer}/source`, what: `token document "${document_.id}"` },
        expectJson: true,
      })
      if (!source.ok) {
        tokenSetComplete = false
        continue
      }
      const flattened = flattenTokens(JSON.parse(source.text), limits)
      if (flattened.tooDeep) {
        tokenSetComplete = false
        collector.add('token-document-too-deep', {
          file: document_.source,
          message: `${document_.source} nests deeper than the maxTokenDepth limit of ${limits.maxTokenDepth}, so its token names were not all collected.`,
        })
      }
      if (flattened.truncated) {
        tokenSetComplete = false
        collector.add('token-document-truncated', {
          file: document_.source,
          message: `${document_.source} declares more than the maxTokensPerDocument limit of ${limits.maxTokensPerDocument}, so its token names were not all collected.`,
        })
      }
      for (const name of flattened.names) tokenNames.add(name)
      summary.tokens += flattened.names.length
      tokenDocuments.push({ id: document_.id, source, names: flattened.names })
      addFile(context, `tokens/${document_.id}.json`, source)
    }
  }

  // --- components ------------------------------------------------------
  const componentIds = new Set(plan.components.map((component) => component.id))
  const componentIdCase = new Map()
  const manifestComponents = []

  if (plan.components.length === 0 && problems.length === 0) {
    collector.add('no-components', {
      file: planFile,
      pointer: jsonPointer('components'),
      message: 'the plan packages no components at all. A pass on no evidence is not a pass, so this is a failure.',
    })
  }
  if (plan.components.length > limits.maxComponents) {
    collector.add('too-many-components', {
      file: planFile,
      pointer: jsonPointer('components'),
      message: `the plan names ${plan.components.length} components, over the maxComponents limit of ${limits.maxComponents}. None were evaluated.`,
    })
    return finish({ collector, summary, manifest: null, files: null, inputs, planFile })
  }

  const seenComponentIds = new Set()
  for (const component of plan.components) {
    if (seenComponentIds.has(component.id)) {
      collector.add('duplicate-component-id', {
        file: planFile,
        pointer: `${component.pointer}/id`,
        message: `component "${component.id}" is declared more than once.`,
      })
      continue
    }
    seenComponentIds.add(component.id)
    const collision = noteCaseCollision(componentIdCase, component.id, true)
    if (collision !== null) {
      collector.add('id-case-collision', {
        file: planFile,
        pointer: `${component.pointer}/id`,
        message: `component "${component.id}" and "${collision}" differ only in case, so they would share a directory on a case-insensitive filesystem and the package would not be reproducible across machines.`,
      })
      continue
    }

    summary.checked += 1
    const entry = {
      id: component.id,
      contract: `components/${component.id}/contract.json`,
      seeAlso: [...component.seeAlso.map((reference) => reference.value)].sort(byCodeUnit),
      tokensUsed: [...component.tokensUsed.map((reference) => reference.value)].sort(byCodeUnit),
      states: [],
    }
    if (component.title !== null) entry.title = excerpt(component.title, 160)

    const contract = await readSource(context, component.contract, {
      at: { pointer: `${component.pointer}/contract`, what: `component "${component.id}"` },
      expectJson: true,
    })
    if (contract.ok) addFile(context, entry.contract, contract)

    if (component.notes !== null) {
      const notes = await readSource(context, component.notes, {
        at: { pointer: `${component.pointer}/notes`, what: `component "${component.id}"` },
      })
      if (notes.ok) {
        entry.notes = `components/${component.id}/notes.md`
        addFile(context, entry.notes, notes)
        await checkNoteLinks(context, component, notes, summary)
      }
    }

    if (component.story !== null) {
      if (component.story.kind === 'external') {
        collector.add('story-link-external', {
          file: planFile,
          pointer: component.story.pointer,
          message: `component "${component.id}" links to a story outside the root. It is recorded in the manifest and never fetched: this tool opens no socket.`,
          evidence: component.story.value,
        })
        entry.story = { kind: 'external', href: excerpt(component.story.value, 400) }
      } else {
        const story = await readSource(context, component.story.value, {
          missingRule: 'story-link-unresolved',
          verifyOnly: true,
          at: { pointer: component.story.pointer, what: `the story link of component "${component.id}"` },
        })
        if (story.ok) entry.story = { kind: 'internal', path: component.story.value }
      }
    }

    for (const reference of component.seeAlso) {
      if (!componentIds.has(reference.value)) {
        collector.add('cross-reference-unresolved', {
          file: planFile,
          pointer: reference.pointer,
          message: `component "${component.id}" refers to "${reference.value}", which no component in this plan declares.`,
        })
      }
    }

    for (const reference of component.tokensUsed) {
      if (!tokenSetComplete) continue
      if (!tokenNames.has(reference.value)) {
        collector.add('token-reference-unresolved', {
          file: planFile,
          pointer: reference.pointer,
          message: `component "${component.id}" cites token "${reference.value}", which no token document in this plan declares.`,
        })
      }
    }
    if (!tokenSetComplete && component.tokensUsed.length > 0) {
      collector.add('token-references-unchecked', {
        file: planFile,
        pointer: `${component.pointer}/tokensUsed`,
        message: `the token set could not be read in full, so the ${component.tokensUsed.length} token citation(s) of component "${component.id}" were not resolved. An unread token document is not an absent token.`,
      })
    }

    await checkStates(context, plan, component, entry, summary, now)
    // Composed at the end, in one fixed key order. Inserting `title` and
    // `notes` where they are discovered would make the manifest's key order
    // depend on which optional fields a component happened to declare, and a
    // manifest is a byte-for-byte contract.
    manifestComponents.push({
      id: entry.id,
      title: entry.title ?? null,
      contract: entry.contract,
      notes: entry.notes ?? null,
      story: entry.story ?? null,
      tokensUsed: entry.tokensUsed,
      seeAlso: entry.seeAlso,
      states: entry.states,
    })
  }

  manifestComponents.sort((left, right) => byCodeUnit(left.id, right.id))

  const files = context.files.slice().sort((left, right) => byCodeUnit(left.path, right.path))
  summary.files = files.length
  summary.components = manifestComponents.length

  const manifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    tool: TOOL_ID,
    package: plan.package === null ? null : { name: excerpt(plan.package.name, 120), version: excerpt(plan.package.version, 60) },
    requiredStates: plan.requiredStates.slice(),
    tokens: tokenDocuments
      .map((document_) => ({ id: document_.id, path: `tokens/${document_.id}.json`, source: document_.source.relativePath, names: document_.names }))
      .sort((left, right) => byCodeUnit(left.id, right.id)),
    components: manifestComponents,
    files: files.map((file) => ({ path: file.path, source: file.source, bytes: file.bytes, sha256: file.sha256 })),
  }

  return finish({ collector, summary, manifest, files, inputs, planFile })
}

async function checkNoteLinks(context, component, notes, summary) {
  const { collector, limits } = context
  const extracted = extractLinks(notes.text, limits.maxNoteLinks)
  if (extracted.truncated) {
    collector.add('note-links-truncated', {
      file: notes.relativePath,
      message: `${notes.relativePath} holds more than the maxNoteLinks limit of ${limits.maxNoteLinks} links, so they were not all checked.`,
    })
  }
  for (const link of extracted.links) {
    const kind = classifyTarget(link.target)
    if (kind === 'fragment') continue
    if (kind === 'external') {
      summary.externalLinks += 1
      collector.add('note-link-external', {
        file: notes.relativePath,
        pointer: `line:${link.line}`,
        message: 'a link leaves the handoff. It is left as written and never fetched: this tool opens no socket.',
        evidence: link.target,
      })
      continue
    }
    const resolved = resolveNoteTarget(notes.relativePath, link.target)
    if (!resolved.ok) {
      collector.add('note-link-unresolved', {
        file: notes.relativePath,
        pointer: `line:${link.line}`,
        message: `a link target could not be resolved inside the root (${resolved.reason}).`,
        evidence: link.target,
      })
      continue
    }
    summary.internalLinks += 1
    await readSource(context, resolved.path, {
      missingRule: 'note-link-unresolved',
      verifyOnly: true,
      at: { file: notes.relativePath, pointer: `line:${link.line}`, what: `the link on line ${link.line}` },
    })
  }
}

async function checkStates(context, plan, component, entry, summary, now) {
  const { collector, planFile, limits } = context

  if (component.states.length > limits.maxStatesPerComponent) {
    collector.add('too-many-states', {
      file: planFile,
      pointer: `${component.pointer}/states`,
      message: `component "${component.id}" declares ${component.states.length} states, over the maxStatesPerComponent limit of ${limits.maxStatesPerComponent}. None were evaluated.`,
    })
    return
  }

  const byName = new Map()
  const stateCase = new Map()
  for (const state of component.states) {
    if (byName.has(state.name)) {
      collector.add('duplicate-state', {
        file: planFile,
        pointer: `${state.pointer}/name`,
        message: `component "${component.id}" declares state "${state.name}" more than once.`,
      })
      continue
    }
    const collision = noteCaseCollision(stateCase, state.name, true)
    if (collision !== null) {
      collector.add('id-case-collision', {
        file: planFile,
        pointer: `${state.pointer}/name`,
        message: `states "${state.name}" and "${collision}" of component "${component.id}" differ only in case, so they would be one file on a case-insensitive filesystem.`,
      })
      continue
    }
    byName.set(state.name, state)
  }

  // The clock is read only when the plan asked for a deadline, and only
  // through the injected `now`. Nothing derived from it reaches the manifest.
  const deadline = plan.evidenceMaxAgeDays === null ? null : now() - plan.evidenceMaxAgeDays * 86400000
  const required = new Set(plan.requiredStates)

  for (const name of [...byName.keys()].sort(byCodeUnit)) {
    const state = byName.get(name)
    const packagePath = `components/${component.id}/states/${name}.json`
    const evidence = await readSource(context, state.evidence, {
      missingRule: required.has(name) ? 'state-evidence-missing' : 'source-missing',
      at: { pointer: `${state.pointer}/evidence`, what: `state "${name}" of component "${component.id}"` },
      expectJson: true,
    })
    if (!evidence.ok) continue
    summary.stateEvidence += 1
    addFile(context, packagePath, evidence)
    const record = { name, required: required.has(name), evidence: packagePath, source: state.evidence }
    if (state.capturedAtText !== null) record.capturedAt = state.capturedAtText
    entry.states.push(record)

    if (deadline === null || !required.has(name)) continue
    if (state.capturedAt === null) {
      collector.add('state-evidence-undated', {
        file: planFile,
        pointer: state.pointer,
        message: `state "${name}" of component "${component.id}" carries no capturedAt, so its age cannot be decided while the plan sets evidenceMaxAgeDays. Undated evidence is not fresh evidence.`,
      })
      continue
    }
    if (state.capturedAt > now()) {
      collector.add('state-evidence-undated', {
        file: planFile,
        pointer: state.pointer,
        message: `state "${name}" of component "${component.id}" claims a capturedAt in the future, so its age cannot be decided.`,
      })
      continue
    }
    if (state.capturedAt < deadline) {
      const days = Math.floor((now() - state.capturedAt) / 86400000)
      collector.add('state-evidence-stale', {
        file: planFile,
        pointer: state.pointer,
        message: `state "${name}" of component "${component.id}" was captured ${days} day(s) ago, past the evidenceMaxAgeDays window of ${plan.evidenceMaxAgeDays}.`,
        suggestion: 'Recapture the evidence, or widen evidenceMaxAgeDays deliberately.',
      })
    }
  }

  entry.states.sort((left, right) => byCodeUnit(left.name, right.name))

  for (const name of plan.requiredStates) {
    if (byName.has(name)) continue
    summary.missingStates += 1
    collector.add('state-evidence-missing', {
      file: planFile,
      pointer: `${component.pointer}/states`,
      message: `component "${component.id}" declares no evidence for the required state "${name}".`,
      suggestion: `Add a states entry named "${name}" pointing at its captured evidence.`,
    })
  }
}

function emptySummary() {
  return {
    checked: 0,
    errors: 0,
    warnings: 0,
    components: 0,
    files: 0,
    tokens: 0,
    stateEvidence: 0,
    missingStates: 0,
    internalLinks: 0,
    externalLinks: 0,
  }
}

/**
 * Decide the status, and it is decided in one place on purpose.
 *
 * Any `evidence` finding makes the run `incomplete`, whatever its severity and
 * whatever else was found: the tool did not learn something it needed, and a
 * run that did not learn something cannot pass. Deleting a single flag
 * elsewhere in this catalog let an entirely unread input report `pass` with
 * the full suite still green, so there is one flag and it is derived from the
 * findings rather than set by hand.
 */
function finish({ collector, summary, manifest, files, inputs, planFile }) {
  const findings = sortFindings(collector.findings)
  let incomplete = false
  for (const finding of findings) {
    const outcome = RULE_OUTCOME[finding.ruleId]
    if (outcome === undefined) throw new TypeError(`Rule "${finding.ruleId}" has no outcome class`)
    if (outcome === 'evidence') incomplete = true
    if (finding.severity === 'error') summary.errors += 1
    if (finding.severity === 'warning') summary.warnings += 1
  }
  const failed = findings.some((finding) => finding.severity === 'error' && RULE_OUTCOME[finding.ruleId] === 'policy')
  const status = incomplete ? 'incomplete' : failed ? 'fail' : 'pass'

  const report = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    tool: TOOL_ID,
    status,
    summary,
    findings,
  }
  return {
    report,
    manifest: status === 'pass' ? manifest : null,
    files: status === 'pass' ? files : null,
    inputs: [...inputs].sort(byCodeUnit),
    planFile,
  }
}

/** The report alone, for a caller that only wants the check. */
export async function auditHandoff(options = {}) {
  return (await inspectHandoff(options)).report
}

/**
 * Write the package.
 *
 * Called only with an inspection that passed, because `inspectHandoff` hands
 * back a null manifest otherwise. The destination is settled before the first
 * byte is written and every file is checked individually: `--out` may hold
 * anything, and a file inside it may be a link to somewhere else or a hard
 * link to a source file this run just hashed.
 */
export async function writeHandoffPackage(inspection, options = {}) {
  const { out, overwrite = false, label = '--out' } = options
  if (inspection.manifest === null || inspection.files === null) {
    throw new TypeError('A package is assembled only from a plan that passed; there is nothing to write')
  }
  if (typeof out !== 'string' || out.trim() === '') throw new TypeError('An output directory is required')

  const realOut = await prepareOutputRoot(out, { allowNonEmpty: overwrite, label })
  for (const input of inspection.inputs) {
    let real
    try {
      real = await realpath(input)
    } catch {
      continue
    }
    if (isInside(realOut, real) || isInside(real, realOut)) {
      throw new DestinationError(
        `${label} ${realOut} overlaps the tree being packaged (${real}). The package is a derived `
        + 'artifact and is written somewhere else, so a run can never rewrite what it read.',
      )
    }
  }

  const written = []
  const serializedManifest = `${JSON.stringify(inspection.manifest, null, 2)}\n`
  for (const file of [...inspection.files, { path: MANIFEST_NAME, content: Buffer.from(serializedManifest, 'utf8') }]) {
    const segments = file.path.split('/')
    const directory = await ensureDirectoryWithin(realOut, segments.slice(0, -1))
    const destination = await assertWritableDestination(resolve(directory, segments[segments.length - 1]), {
      inputs: inspection.inputs,
      root: realOut,
      label,
      rootLabel: `${label} ${realOut}`,
    })
    await writeFile(destination, file.content)
    written.push(file.path)
  }
  return { out: realOut, written: written.sort(byCodeUnit) }
}

export function exitCodeFor(report) {
  if (report.status === 'incomplete') return 2
  return report.status === 'fail' ? 1 : 0
}

export function formatReport(report) {
  const lines = []
  const { summary } = report
  lines.push(
    `plan: ${summary.checked} component(s) checked, ${summary.components} packaged, `
    + `${summary.files} file(s), ${summary.tokens} token name(s).`,
  )
  lines.push(
    `evidence: ${summary.stateEvidence} state file(s), ${summary.missingStates} required state(s) with none. `
    + `links: ${summary.internalLinks} internal, ${summary.externalLinks} external and never fetched.`,
  )
  for (const finding of report.findings) {
    const where = finding.location.pointer === undefined
      ? finding.location.file
      : `${finding.location.file}#${finding.location.pointer}`
    lines.push(`${finding.severity} ${finding.ruleId} ${where}: ${finding.message}`)
  }
  lines.push(`status ${report.status}. ${summary.errors} error(s), ${summary.warnings} warning(s).`)
  return `${lines.join('\n')}\n`
}
