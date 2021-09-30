#!/usr/bin/env node

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import {
  DestinationError,
  exitCodeFor,
  formatReport,
  inspectHandoff,
  parseInstant,
  writeHandoffPackage,
} from '../src/index.mjs'

const HELP = `design-handoff-packager

Check a design handoff plan and write a portable handoff package.

Reads a plan, the component contracts, design tokens, usage notes and per-state
evidence it names, and reports every internal link that does not resolve and
every required state that has no evidence. When -- and only when -- the check
passes, it writes the package: the named files under fixed names, plus a
manifest whose every path is relative to the package.

Usage:
  design-handoff-packager --root DIR [--plan FILE] [--out DIR] [options]

Options:
  --root DIR          Directory the plan and every file it names live in.
                      Required. Every path in the report is relative to it.
  --plan FILE         The plan, relative to the root (default: handoff.json).
                      It must resolve inside the root, so that no report line
                      can carry an absolute host path.
  --out DIR           Write the handoff package here. Omit it to check only.
                      Refused when it is a symbolic link, when it exists and
                      is not a directory, when its parent does not exist (only
                      the last segment is created), and when it overlaps the
                      tree being packaged. The directory itself is NOT
                      confined to anything: it is a path you name, and a
                      symbolically linked parent on the way to it is followed,
                      exactly as mkdir and cp follow one. Every file written
                      INSIDE it is confined to its real path, is refused if it
                      is a link, and is refused if it is one of the files
                      being packaged -- including through a hard link, which
                      shares no path with the file it names. Every one of
                      those checks runs before the first byte is written, so
                      a refusal never leaves half a package behind.
  --overwrite         Write into a --out directory that already holds entries.
                      Each file is still checked individually.
  --now INSTANT       The current time, as an ISO-8601 UTC instant, for the
                      evidenceMaxAgeDays window. Supply it and the run reads
                      no clock at all. Without evidenceMaxAgeDays in the plan,
                      no clock is read either way.
  --limit NAME=VALUE  Override one documented limit. An unknown name is an
                      error rather than a silent no-op.
  --json              Suppress the human summary on stderr. The JSON report
                      goes to stdout either way.
  -h, --help          Show this help and exit 0.
  --version           Print the version and exit 0.

Exit codes:
  0  checked, every internal link resolved and every required state had
     evidence; the package was written if --out was given
  1  checked, and at least one error-severity rule fired; nothing was written
  2  invalid usage or a refused destination (stdout stays EMPTY and no file
     is written; the --out directory and the subdirectories inside it may
     have been created), or evidence that could not be obtained (stdout
     carries a report whose status is "incomplete")

--help and --version sit outside that table: they answer a question about the
tool rather than about a handoff, and both exit 0.

The tool opens no socket. A story link or a note link that leaves the root is
recorded and never fetched.
`

function parseArguments(argv) {
  const options = { root: null, plan: null, out: null, overwrite: false, now: null, limits: {}, json: false }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const takeValue = (name) => {
      const value = argv[index + 1]
      if (value === undefined) throw new TypeError(`${name} requires a value`)
      index += 1
      return value
    }
    if (argument === '-h' || argument === '--help') return { help: true }
    else if (argument === '--version') return { version: true }
    else if (argument === '--json') options.json = true
    else if (argument === '--overwrite') options.overwrite = true
    else if (argument === '--root') options.root = takeValue('--root')
    else if (argument === '--plan') options.plan = takeValue('--plan')
    else if (argument === '--out') options.out = takeValue('--out')
    else if (argument === '--now') options.now = takeValue('--now')
    else if (argument === '--limit') {
      const pair = takeValue('--limit')
      const split = pair.indexOf('=')
      if (split < 1) throw new TypeError(`--limit expects NAME=VALUE; received "${pair}"`)
      const name = pair.slice(0, split)
      const value = Number(pair.slice(split + 1))
      if (!Number.isInteger(value) || value < 1) throw new TypeError(`--limit ${name} expects a positive integer`)
      options.limits[name] = value
    } else throw new TypeError(`Unknown option "${argument}"`)
  }
  if (options.root === null) throw new TypeError('--root is required')
  if (options.overwrite && options.out === null) throw new TypeError('--overwrite has no meaning without --out')
  return options
}

async function version() {
  const here = dirname(fileURLToPath(import.meta.url))
  const manifest = JSON.parse(await readFile(join(here, '..', 'package.json'), 'utf8'))
  return manifest.version
}

async function main(argv) {
  let options
  try {
    options = parseArguments(argv)
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${HELP}`)
    return 2
  }
  if (options.help) {
    process.stdout.write(HELP)
    return 0
  }
  if (options.version) {
    process.stdout.write(`${await version()}\n`)
    return 0
  }

  let clock
  if (options.now !== null) {
    const instant = parseInstant(options.now)
    if (instant === null) {
      process.stderr.write('--now expects an ISO-8601 UTC instant such as 2026-01-31T09:00:00Z\n')
      return 2
    }
    clock = () => instant
  }

  let inspection
  try {
    inspection = await inspectHandoff({
      root: options.root,
      ...(options.plan === null ? {} : { plan: options.plan }),
      ...(clock === undefined ? {} : { now: clock }),
      limits: options.limits,
    })
  } catch (error) {
    // A configuration error means the run never had a subject, so stdout stays
    // empty: there is nothing to report about.
    process.stderr.write(`${error.message}\n`)
    return 2
  }

  if (options.out !== null && inspection.manifest !== null) {
    try {
      const written = await writeHandoffPackage(inspection, { out: options.out, overwrite: options.overwrite })
      process.stderr.write(`Wrote ${written.written.length} file(s) to ${written.out}\n`)
    } catch (error) {
      if (!(error instanceof DestinationError) && !(error instanceof TypeError)) throw error
      // Refused before any file was written, and before the report was
      // emitted: every destination is settled first, so a refusal anywhere
      // means none of them were written. A refused destination is a
      // configuration error, so stdout stays empty rather than carrying a
      // report about a run whose output never happened.
      process.stderr.write(`${error.message}\n`)
      return 2
    }
  }

  process.stdout.write(`${JSON.stringify(inspection.report, null, 2)}\n`)
  if (!options.json) process.stderr.write(formatReport(inspection.report))
  if (options.out !== null && inspection.manifest === null) {
    process.stderr.write('Nothing was written: a plan that does not hold together is not packaged.\n')
  }
  return exitCodeFor(inspection.report)
}

process.exitCode = await main(process.argv.slice(2))
