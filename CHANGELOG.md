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
