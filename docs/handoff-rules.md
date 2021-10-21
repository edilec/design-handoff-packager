# Handoff rules

Every finding this tool emits carries one of the rule ids below. A rule id is
stable across releases; renaming one is a breaking change and is recorded in
the changelog.

Two properties are attached to each rule, and they answer different questions.

**Severity** — `error`, `warning` or `info` — is how serious the finding is.
Only an `error` can fail a run.

**Outcome class** is what the finding says about the run itself:

- `policy` means the tool obtained its evidence and the plan contradicted it.
  A file that is not there is a policy failure: the tool looked.
- `evidence` means the tool could not obtain the evidence at all. An unreadable
  file is **not** an absent one. Any `evidence` finding makes the run
  `incomplete` and exits 2, whatever its severity and whatever else was found,
  because a run that did not learn something cannot pass and must not report
  what it did not learn as absence.

`src/index.mjs` holds both tables frozen, every finding takes its values from
them, and an unknown rule id throws. `test/severity-table.test.mjs` asserts this
document against those tables in both directions, so a rule cannot be added to
one without the other. That agreement is a source of truth, not the test:
`test/severity-behaviour.test.mjs` drives real plans through the real entry
point and asserts the exit codes, because three declarations can be edited
together and an exit code cannot be edited at all.

| Rule | Severity | Outcome | What it means |
| --- | --- | --- | --- |
| `cross-reference-unresolved` | error | policy | A component's `seeAlso` names a component this plan does not declare. A component the plan declares and the schema check then dropped still counts as declared: it already carries its own error, and absence from the surviving set is not absence from the plan. |
| `duplicate-component-id` | error | policy | Two components share an id. |
| `duplicate-state` | error | policy | One component declares the same state name twice. |
| `duplicate-token-document-id` | error | policy | Two token documents share an id exactly. They would be written to one path in the package, so one manifest entry would describe a file that is not the one beside it. This is a separate rule from `id-case-collision`: an exact duplicate is one file on every filesystem, not only a case-insensitive one. |
| `id-case-collision` | error | policy | Two ids, state names or token document ids differ only in case. They would be one path on a case-insensitive filesystem, so the package would not be reproducible across machines. |
| `no-components` | error | policy | The plan packages nothing. A pass on no evidence is not a pass. |
| `note-link-external` | info | policy | A link in a usage note leaves the handoff. It is recorded as written and never fetched. |
| `note-link-unresolved` | error | policy | A relative link in a usage note names no file inside the root. |
| `note-links-truncated` | error | evidence | A note holds more links than `maxNoteLinks`, so they were not all checked. |
| `package-too-large` | error | evidence | The files to be packaged exceed `maxPackageBytes`, so the package was not assembled. |
| `plan-invalid-json` | error | evidence | The plan is not valid JSON. The document is never reproduced in the message. |
| `plan-not-utf8` | error | evidence | The plan is not valid UTF-8, so it was not parsed. |
| `plan-schema-invalid` | error | policy | A field of the plan is missing, is the wrong shape, or is an unknown key. |
| `plan-too-large` | error | evidence | The plan is larger than `maxPlanBytes`. It was not read. |
| `plan-unreadable` | error | evidence | The plan could not be opened, or there is none at that path. |
| `root-unreadable` | error | evidence | The root directory could not be resolved. |
| `source-escapes-root` | error | policy | A path the plan names resolves outside the root. A link on the way does not widen the root. |
| `source-invalid-json` | error | evidence | A contract, token document or evidence file is not valid JSON. |
| `source-missing` | error | policy | A path the plan names has no file under the root. |
| `source-not-a-file` | error | policy | A path the plan names exists but is not a regular file. |
| `source-not-utf8` | error | evidence | A file that is packaged is not valid UTF-8, so its content was not examined. |
| `source-too-large` | error | evidence | A file is larger than `maxFileBytes`. It was not read. |
| `source-unreadable` | error | evidence | A file exists and could not be read. This is never reported as absence. |
| `state-evidence-missing` | error | policy | A required state has no entry, or its evidence file is not there. A state the component declares and the schema check then dropped -- for a refused evidence path, a duplicate name or a case collision -- is not "no entry": it already carries its own error. |
| `state-evidence-stale` | error | policy | A required state's evidence was captured before the `evidenceMaxAgeDays` window. |
| `state-evidence-undated` | error | policy | A window is declared and a required state's evidence carries no usable `capturedAt`, so its age cannot be decided. Undated evidence is not fresh evidence. |
| `story-link-external` | info | policy | A component's story link leaves the root. It is recorded in the manifest and never fetched. |
| `story-link-unresolved` | error | policy | A component's story link is relative and names no file inside the root. |
| `token-document-too-deep` | error | evidence | A token document nests deeper than `maxTokenDepth`, so its names were not all collected. |
| `token-document-truncated` | error | evidence | A token document declares more names than `maxTokensPerDocument`. |
| `token-name-unusable` | error | policy | A token group or key cannot be named by a dotted citation, so no plan could refer to it. |
| `token-reference-unresolved` | error | policy | A component cites a token that no token document in this plan declares. |
| `token-references-unchecked` | error | evidence | The token set could not be read in full, so citations were not resolved at all. Absence from a partial set is not evidence of absence. A key `token-name-unusable` had to drop counts as not read in full, because the index the citations are compared against is missing it. |
| `too-many-components` | error | evidence | The plan names more components than `maxComponents`. None were evaluated. |
| `too-many-files` | error | evidence | The plan names more files than `maxFiles`. |
| `too-many-states` | error | evidence | One component declares more states than `maxStatesPerComponent`. None of its states were evaluated. |
| `too-many-token-documents` | error | evidence | The plan names more token documents than `maxTokenDocuments`. |

## Ordering

Findings are sorted by
`(location.file, location.pointer, ruleId, message, evidence)`, compared by
UTF-16 code unit. Locale-aware comparison depends on ICU data that differs
between Node builds, so it is not used and its absence is pinned behaviourally
rather than by a source scan.

## Absence, and what may be compared against

Three rules answer "the plan does not declare this": `cross-reference-unresolved`,
`state-evidence-missing` and `token-reference-unresolved`. Each answers out of an
index built while walking the plan, and an index built while dropping evidence
cannot answer it. So:

- a component or a state the plan declares counts as declared even when the
  entry was dropped, because the drop already carries its own error and saying
  it a second time as an absence would be a claim about something the plan
  spells out;
- and a token document that lost a name on its way into the index makes the
  citation comparison `incomplete`, never clean.

`location.pointer` is a JSON Pointer into the plan for a finding about the
plan, and the documented field path `line:<n>` for a finding about a link
written inside a Markdown usage note.
