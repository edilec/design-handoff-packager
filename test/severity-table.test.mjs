/**
 * The rule tables and the document that describes them, asserted in both
 * directions.
 *
 * This is a consistency check on three declarations, not the severity test.
 * One tool in this catalog had 40 of 52 error rules survive a coordinated flip
 * of exactly this kind of agreement. `severity-behaviour.test.mjs` is the test
 * that bites; this one keeps the document honest.
 */

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import { RULE_OUTCOME, RULE_SEVERITY } from '../src/index.mjs'

const DOC = fileURLToPath(new URL('../docs/handoff-rules.md', import.meta.url))

async function documented() {
  const text = await readFile(DOC, 'utf8')
  const rows = new Map()
  for (const line of text.split(String.fromCharCode(10))) {
    const found = /^\| `([a-z0-9-]+)` \| (error|warning|info) \| (policy|evidence) \|/.exec(line)
    if (found !== null) rows.set(found[1], { severity: found[2], outcome: found[3] })
  }
  return rows
}

describe('the rule catalog', () => {
  test('documents every rule the code can emit', async () => {
    const rows = await documented()
    for (const ruleId of Object.keys(RULE_SEVERITY)) {
      assert.ok(rows.has(ruleId), ruleId + ' is emitted but not documented')
    }
  })

  test('emits every rule it documents', async () => {
    const rows = await documented()
    for (const ruleId of rows.keys()) {
      assert.ok(Object.hasOwn(RULE_SEVERITY, ruleId), ruleId + ' is documented but not in the severity table')
    }
  })

  test('agrees with the document on severity and outcome', async () => {
    const rows = await documented()
    for (const [ruleId, row] of rows) {
      assert.equal(RULE_SEVERITY[ruleId], row.severity, ruleId + ' severity')
      assert.equal(RULE_OUTCOME[ruleId], row.outcome, ruleId + ' outcome')
    }
    assert.ok(rows.size >= 30, 'the document parser found ' + rows.size + ' rows, which looks like a parsing failure')
  })

  test('gives every severity rule an outcome class and the reverse', () => {
    assert.deepEqual(Object.keys(RULE_SEVERITY).sort(), Object.keys(RULE_OUTCOME).sort())
  })

  test('uses only the severities the contract allows', () => {
    for (const [ruleId, severity] of Object.entries(RULE_SEVERITY)) {
      assert.ok(['error', 'warning', 'info'].includes(severity), ruleId)
    }
  })

  test('freezes both tables, so nothing can be added at runtime', () => {
    assert.ok(Object.isFrozen(RULE_SEVERITY))
    assert.ok(Object.isFrozen(RULE_OUTCOME))
  })
})
