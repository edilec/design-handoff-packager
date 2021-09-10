# design-handoff-packager

Check a design handoff before you send it, then package it.

The tool reads a **plan** — the component contracts, design tokens, usage notes,
story links and per-state evidence that make up a handoff — resolves every
internal link in it, checks that every required state actually has evidence, and
writes a portable directory with a manifest whose paths are relative and
reproducible.

- **Repository:** [edilec/design-handoff-packager](https://github.com/edilec/design-handoff-packager)
- **License:** MIT
- **Runtime:** Node 22 or later, no runtime and no development dependencies

## Why it exists

A handoff fails quietly. The contract is there, the tokens are there, and the
one thing nobody checked — the focus-visible screenshot, the anatomy note the
usage doc links to, the token the component cites by a name that was renamed
last month — is missing. The person who opens the package finds out, on a
different machine, a week later.

So: the check and the package are the same run, and the package is written only
when the check passes. A manifest pointing at files that were never found is
worse than no manifest.

## Quick start

```sh
# check a handoff
design-handoff-packager --root examples/clean

# check it and write the package
design-handoff-packager --root examples/clean --out /tmp/handoff

# a handoff that does not hold together: exits 1 and writes nothing
design-handoff-packager --root examples/broken --json | jq '.findings[].ruleId'
```

The JSON report goes to stdout and nothing else does, so stdout pipes straight
into a parser. The human summary and every diagnostic go to stderr; `--json`
suppresses the summary.

```
plan: 2 component(s) checked, 2 packaged, 14 file(s), 5 token name(s).
evidence: 8 state file(s), 0 required state(s) with none. links: 4 internal, 1 external and never fetched.
status pass. 0 error(s), 0 warning(s).
```

As a library:

```js
import { exitCodeFor, formatReport, inspectHandoff, writeHandoffPackage } from 'design-handoff-packager'

const inspection = await inspectHandoff({ root: 'examples/clean' })
process.stderr.write(formatReport(inspection.report))
if (inspection.manifest !== null) await writeHandoffPackage(inspection, { out: '/tmp/handoff' })
process.exitCode = exitCodeFor(inspection.report)
```

## The plan

`handoff.json` in the root, or wherever `--plan` says, as long as it resolves
inside the root.

```json
{
  "schemaVersion": "1",
  "package": { "name": "edilec-ui", "version": "3.2.0" },
  "requiredStates": ["default", "hover", "focus-visible", "disabled"],
  "evidenceMaxAgeDays": 90,
  "tokens": [{ "id": "color", "source": "tokens/color.tokens.json" }],
  "components": [
    {
      "id": "button",
      "title": "Button",
      "contract": "contracts/button.json",
      "notes": "notes/button.md",
      "story": "https://storybook.example.invalid/?path=/story/button--primary",
      "tokensUsed": ["color.brand.primary"],
      "seeAlso": ["icon-button"],
      "states": [
        { "name": "default", "evidence": "evidence/button/default.json", "capturedAt": "2026-08-14T10:00:00Z" }
      ]
    }
  ]
}
```

Every key is checked, and an **unknown key is an error**: a one-character typo
in `requiredStates` would otherwise turn a real failure into a green run.

`evidenceMaxAgeDays` is optional. When it is absent the tool reads no clock at
all. When it is present, pass `--now` to decide the window from a fixed instant
rather than from whenever the run happened.

## What "all internal links resolve" covers

| Link | Where it is written | Resolved against |
| --- | --- | --- |
| Component contract | `components[].contract` | the root |
| Usage note | `components[].notes` | the root |
| Token document | `tokens[].source` | the root |
| State evidence | `components[].states[].evidence` | the root |
| Story link | `components[].story` | the root, unless it carries a scheme |
| Token citation | `components[].tokensUsed[]` | the names the token documents declare |
| Cross reference | `components[].seeAlso[]` | the component ids in this plan |
| Markdown link | inline `[text](target)` inside a usage note | the note's own directory |

A link that carries a scheme, or a story link that does, is recorded as written
and reported at `info`. **It is never fetched.** The tool opens no socket at any
point, in any mode, including in its tests.

## The package

```
manifest.json
tokens/<token-document-id>.json
components/<component-id>/contract.json
components/<component-id>/notes.md
components/<component-id>/states/<state-name>.json
```

Names inside the package are fixed, so a source file's own name cannot change
the result. Every path in the manifest is relative, uses `/` on every platform,
and carries the source path it came from plus its size and SHA-256. Two
checkouts of the same tree at two different absolute locations produce
byte-identical manifests.

Component ids, state names and token document ids become path segments, so they
must be letters, digits, `.`, `-` or `_`, starting with a letter or digit. Two
that differ only in case are refused: they would be one path on a
case-insensitive filesystem, and the package would then mean different things on
different machines.

## Exit codes

| Exit | Meaning | stdout |
| ---: | --- | --- |
| `0` | every internal link resolved and every required state had evidence | the report |
| `1` | at least one error-severity rule fired; **nothing was written** | the report |
| `2` | invalid usage, or a refused destination; nothing was written | **empty** |
| `2` | evidence that could not be obtained; status `incomplete` | the report |

A consumer that pipes stdout must handle an empty stdout on exit 2. A
configuration error means the run never had a subject, so there is nothing to
report about; evidence that could not be obtained means the run had a subject
and failed to learn something about it, and the report says which input that
was.

`--help` and `--version` sit outside that table and exit 0.

## Rules

The full catalog, with the severity and the outcome class of every rule, is in
[docs/handoff-rules.md](./docs/handoff-rules.md). The short version:

- **A link that does not resolve, or a required state with no evidence, fails
  the run** — exit 1, and nothing is packaged.
- **Evidence the tool could not obtain makes the run `incomplete`** — exit 2.
  An unreadable file is never reported as an absent one, and a token set that
  could not be read in full stops the citation check rather than reporting every
  citation as unresolved.
- **A link that leaves the handoff is information**, recorded and never fetched.

## Limits

Every limit is enforced, overridable with `--limit NAME=VALUE`, and named in the
finding when it is reached. Exceeding one is an `incomplete` result — never a
quietly smaller package, and never a pass. An unknown limit name is an error.

| Limit | Default | What it bounds |
| --- | ---: | --- |
| `maxPlanBytes` | 262144 | the plan document |
| `maxComponents` | 400 | components in one plan |
| `maxStatesPerComponent` | 40 | states on one component |
| `maxTokenDocuments` | 50 | token documents in one plan |
| `maxTokensPerDocument` | 5000 | token names collected from one document |
| `maxTokenDepth` | 12 | group nesting inside a token document |
| `maxFileBytes` | 1048576 | any one file that is read or packaged |
| `maxFiles` | 1200 | files in the package |
| `maxPackageBytes` | 16777216 | the package in total |
| `maxNoteLinks` | 200 | links checked in one usage note |

## Writing files safely

The package is a derived artifact and is written somewhere else: a destination
that resolves inside the root, or that contains it, is refused. Beyond that,
three independent holes are each checked separately, because guarding one or two
is what every tool that lost a file had already done.

- **A symbolic link at the destination** is refused on sight, with `lstat`,
  before anything is opened. `realpath` does not help: resolving the link is the
  dangerous act.
- **A symbolically linked parent inside the package** is refused. Directories are
  created one segment at a time, because `mkdir -p` walks through a link without
  comment.
- **A hard link to a file this run read — or merely named** — is refused by
  comparing device and inode. It has no target to resolve and shares no path
  with the file it names, so nothing else sees it. The input set is every path
  the tool stats, lists or reasons about, not only the ones it opens.

`--out` **itself is not confined to anything.** It is a path you name, and a
symbolically linked parent on the way to it is followed, exactly as `mkdir` and
`cp` follow one. There is no root for it to escape from. What is confined is
every file written *inside* it. Only the last segment of `--out` is created: a
parent that does not exist is refused rather than conjured. A directory that
already holds entries needs `--overwrite`.

## Guarantees

Each of these has a test that fails when the behaviour is removed, which is the
only kind of guarantee worth stating:

1. A plan that does not hold together is never packaged, and a failing run
   writes no file at all.
2. Nothing the tool reads is ever written to.
3. The same plan and sources produce byte-identical output from any absolute
   location, and a second run produces byte-identical stdout.
4. No absolute host path appears in the report or the manifest.
5. Evidence that could not be obtained never satisfies a check and never passes.
6. No untrusted string reaches output carrying a C0, DEL, C1, line-separator or
   bidi control character, whether it arrived as an excerpt or as an identifier.
7. A JSON parse failure never reproduces the document.
8. Ordering is by UTF-16 code unit, never by a collation table.
9. A value that cannot be stringified costs a finding, never the report.
10. No clock is read unless the plan declares `evidenceMaxAgeDays`, and `--now`
    decides the window when it does.

## Non-goals

- **It does not fetch anything.** A story link or a note link with a scheme is
  recorded and never opened. No socket, no host resolution, no browser.
- **It does not render, screenshot or measure.** State evidence is a document
  somebody else exported; this tool checks that it is there, that it parses, and
  that it is not older than the plan allows.
- **It does not resolve token aliases or compute token values.** A citation is
  checked against the names a token document declares, and nothing else.
- **It does not follow reference-style Markdown links** (`[text][ref]`),
  autolinks, bare URLs or HTML anchors inside a note. Only inline
  `[text](target)` links outside fenced code and inline code spans are checked.
- **It does not modify the source tree**, and has no auto-fix.
- **It does not verify that a contract or an evidence document means anything.**
  It checks that the file is there, is UTF-8, and is valid JSON.

## Development

```sh
npm run check    # lint, tests, the runnable examples, and a pack dry run
```

## License

MIT. See [LICENSE](./LICENSE).
