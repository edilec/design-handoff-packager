/** Shared fixtures. Nothing here asserts; the tests do. */

import { Buffer } from 'node:buffer'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const BIN = fileURLToPath(new URL('../bin/design-handoff-packager.mjs', import.meta.url))
export const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url))

const roots = []

/** A temporary directory removed when the process exits normally. */
export async function scratch(prefix = 'dhp-') {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

export async function cleanup() {
  while (roots.length > 0) await rm(roots.pop(), { recursive: true, force: true })
}

/** Write a map of relative path to contents, creating directories as needed. */
export async function writeTree(root, files) {
  for (const [relative, contents] of Object.entries(files)) {
    const target = resolve(root, relative)
    await mkdir(dirname(target), { recursive: true })
    const payload = typeof contents === 'string' || Buffer.isBuffer(contents)
      ? contents
      : JSON.stringify(contents, null, 2)
    await writeFile(target, payload)
  }
  return root
}

export function json(value) {
  return JSON.stringify(value, null, 2)
}

/**
 * A plan that passes, so a test can break exactly one thing about it.
 *
 * `states` covers `requiredStates` exactly, every path exists in `treeFor`,
 * and the token citation resolves.
 */
export function planFor(overrides = {}) {
  return {
    schemaVersion: '1',
    package: { name: 'fixture-ui', version: '1.0.0' },
    requiredStates: ['default', 'disabled'],
    tokens: [{ id: 'color', source: 'tokens/color.json' }],
    components: [
      {
        id: 'button',
        contract: 'contracts/button.json',
        notes: 'notes/button.md',
        tokensUsed: ['color.brand.primary'],
        seeAlso: [],
        states: [
          { name: 'default', evidence: 'evidence/button-default.json' },
          { name: 'disabled', evidence: 'evidence/button-disabled.json' },
        ],
      },
    ],
    ...overrides,
  }
}

export function treeFor(plan = planFor(), extra = {}) {
  return {
    'handoff.json': json(plan),
    'tokens/color.json': json({ color: { brand: { primary: { $value: '#123456' } } } }),
    'contracts/button.json': json({ name: 'Button' }),
    'notes/button.md': '# Button\n\nSee the [contract](../contracts/button.json).\n',
    'evidence/button-default.json': json({ state: 'default' }),
    'evidence/button-disabled.json': json({ state: 'disabled' }),
    ...extra,
  }
}

/** Build a passing tree in a fresh scratch directory. */
export async function fixture(plan = planFor(), extra = {}) {
  const root = await scratch()
  await writeTree(root, treeFor(plan, extra))
  return root
}

export function runCli(args, options = {}) {
  const result = spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    cwd: options.cwd ?? PACKAGE_ROOT,
    ...(options.env === undefined ? {} : { env: { ...process.env, ...options.env } }),
  })
  return { code: result.status, stdout: result.stdout, stderr: result.stderr }
}

/** Parse the CLI's stdout, failing loudly rather than returning undefined. */
export function reportFrom(result) {
  if (result.stdout === '') throw new Error(`stdout was empty; stderr was: ${result.stderr}`)
  return JSON.parse(result.stdout)
}

export function ruleIds(report) {
  return report.findings.map((finding) => finding.ruleId)
}
