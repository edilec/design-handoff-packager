# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

Rule ids are part of the public interface. Renaming or removing one is a
breaking change and is recorded here.

## [Unreleased]

### Added

- `duplicate-token-document-id` (error, policy): two token documents declared
  under exactly the same id. `id-case-collision` refused two ids that differ
  only in case, because they would be one file on a case-insensitive
  filesystem; two ids that are exactly equal are one file on every filesystem,
  and that case had no check. The run exited 0 having written four files while
  reporting five, and the manifest described `tokens/color.json` twice with two
  sources, two byte counts and two digests -- one of which did not match the
  file beside it.

### Fixed

- A destination refused part-way through the package write left the files
  before it on disk -- thirteen package files and no manifest -- while the exit
  code, the README exit-code table and the help text all said nothing had been
  written. Every destination is now settled before the first byte is written.
  The `--out` directory and the subdirectories inside it are still created
  during that check, because a destination cannot be inspected until its parent
  exists; the README and the help text now say so instead of claiming more.
- `--out` pointing inside the tree being packaged created the directory and
  only then refused the run, leaving a new empty directory inside a source tree
  the README says is never modified. The overlap check now runs while the
  destination is still only a path. `resolveOutputRoot` is the new, effect-free
  half of `prepareOutputRoot`.
- `writeHandoffPackage` refuses two package files claiming one path, rather than
  writing one over the other and leaving the manifest describing neither.
- `root-unreadable` carried the caller's whole absolute root inside its message,
  which falsified the guarantee that no absolute host path appears in the
  report. The test that claimed to pin that guarantee only ever walked a
  passing tree, so it never reached the one finding raised before anything is
  known to be relative to anything. It now walks a failing report, an
  incomplete one, and that one.
- The test named "a plan that names no output directory writes nothing" asserted
  `readdir()` of a fresh scratch directory the CLI was never told about and
  `JSON.stringify({}, null, 2) === '{}'`: two constants, and a mutation that
  wrote a whole package into `tmpdir()` on every run with no `--out` left the
  suite green. The run is now given a working directory, a temporary directory
  and a home directory of its own, and all three are asserted empty afterwards
  along with the tree it was handed.
- The test named "an evidence file that exists but cannot be read is incomplete,
  not missing" drove a fixture that produces `fail`, and asserted no status at
  all. A directory standing where the evidence should be is a definite answer,
  not an unknown, so `fail` is right and the name was wrong. It now says what it
  checks and asserts the status, and the case that really is incomplete -- an
  evidence file that exists and cannot be read -- has a test of its own that
  proves its fixture is unreadable before relying on it.
- The severity and outcome tables were pinned by a test that read them. Sweeping
  every rule -- flipping its severity one step, and its outcome class, in the
  source table and in `docs/handoff-rules.md` together -- left 20 of 74 such
  edits with the suite green, including every `policy -> evidence` flip, because
  the expected exit code moved with the table. Each case now carries a
  hand-written expectation of the observed output (`fail`, `incomplete` or
  `clean`) with the error and warning counts, and a separate test says which
  case to revisit when a table is changed deliberately. All 74 are now killed.
- A `--plan` that resolves outside the root and does not exist produced a report
  whose `location.file` climbed out of the root with one `../` per directory the
  root sits under, so the same configuration produced different report bytes on
  two machines. Containment is now decided before the file is looked for:
  whether the file exists is a different question from whether the caller was
  allowed to name it.

### Added

- `severityFor`, `outcomeFor` and `sameFile` are exported. Each was a refusal
  buried inside a function no test could reach, and a refusal with no test that
  fails when it is removed is a refusal that will quietly stop happening.
  `sameFile` answers `same`, `different` or `unknown`, and `unknown` is the
  answer a filesystem that reports no inode gives; the caller refuses on it
  exactly as it refuses on `same`.
- `resolveOutputRoot`: the effect-free half of `prepareOutputRoot`, which
  answers where `--out` resolves without creating anything.

### Measured and recorded rather than claimed

A sweep of 197 mutations -- every severity flipped one step, every outcome
class flipped, every `throw` in `src/` neutralised, every ordering call site
given a collator -- left five standing after the tests above were written.
Each is an equivalent mutant, and each is recorded here with what proves it
rather than counted as coverage:

- **The `ruleId` key of the finding sort.** No two of the 37 rule ids order
  differently under collation: 666 pairs, zero disagreements. A test asserts
  that, so the day a new rule id breaks it, the site needs a fixture and says
  so.
- **The order state evidence is read in.** Sorting `byName` decides only the
  order of side effects that are all re-sorted or counted afterwards. Measured
  against a collator over a plan with the states `Zoom`, `always`, `default`,
  `disabled`, `Beta` and `beta2`, with no limit and with `maxFiles`,
  `maxPackageBytes` and `maxStatesPerComponent` each set low enough to truncate:
  byte-identical stdout, byte-identical stderr and byte-identical package.
- **The control-character half of `isIdentifier`.** The shape it tests admits
  only the 65 characters in the printable ASCII run `0x2D`-`0x7A`; every class
  the control check catches lies below `0x20`, between `0x7F` and `0x9F`, or
  above `0x2000`. A probe over the first 0x2200 code points asserts it.
- **`mkdir` without `recursive`.** `resolveOutputRoot` refuses a parent that
  does not exist before this runs. Measured over a fresh destination, a missing
  parent, an existing empty directory and an existing non-empty one: same exit
  code, byte-identical stdout, stderr and directory tree.
- **The zero-inode refusal in the write guard.** No filesystem this runs on
  reports a zero inode, so the branch has no fixture and never will. The
  decision it acts on is `sameFile`, which is pure, exported and tested,
  including its `unknown` answer.

## [0.1.0] - 2026-09-18

First working release.

### Added

- `inspectHandoff`, `auditHandoff` and `writeHandoffPackage`, plus the
  `design-handoff-packager` command line entry point.
- Resolution of every internal link a plan makes: component contracts, usage
  notes, token documents, per-state evidence, story links, token citations,
  cross references between components, and the inline Markdown links written
  inside a usage note.
- A required-state check: a state the plan requires must have an entry and that
  entry's evidence file must be there.
- An optional `evidenceMaxAgeDays` window, decided from an injected clock. No
  clock is read at all when the plan declares no window.
- A portable handoff package with a manifest whose paths are relative, use `/`
  on every platform, and carry the source path, size and SHA-256 of every file.
  The package is written only when the check passes.
- 36 rules with a frozen severity table and a frozen outcome-class table,
  documented in `docs/handoff-rules.md` and asserted against it in both
  directions.
- Three runnable example trees: one that passes, one that fails on policy alone,
  and one that needs an injected clock.

### Fixed during the build

These were found by removing a guard and watching the test suite, not by
reading the code:

- A relative path the plan names is recorded verbatim in the manifest, so it
  never passes through the sanitising excerpt. Validating only that a segment
  still renders as something let a path containing U+2028 through with the
  separator intact. Path segments are now refused outright when they carry a
  control, separator or bidi character.
- The sanitisation tests asked the tool's own detector whether the tool had
  stripped the class the tool defines, so narrowing the class narrowed the
  oracle with it: removing the C1 range left the suite green while U+0085
  reached stdout. The tests now look for the character itself.
- The parse-failure suite never reached the closing double-quote backstop,
  because with the branches in the right order nothing needed it. It now feeds
  a wording that ends in an offset while still carrying a quoted credential.
- `source-unreadable` was only exercised through a failed read. A file behind a
  directory that cannot be entered fails at `realpath` instead, and that branch
  could have reported the file as absent with nothing noticing.
- Two external links written on one line of one note tied on file, pointer,
  rule and message, so their order came from the order the regular expression
  matched. The documented sort key now ends in `evidence`.
- A token group or key that no dotted citation could name was silently dropped.
  It is now reported: a name that prints one way in the manifest and matches
  another in the citation check cannot be audited.
