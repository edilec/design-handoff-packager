/**
 * The parse-failure helper, pinned on the cases that broke it elsewhere.
 *
 * Nineteen of thirty-eight tools in this catalog shipped the position-first
 * ordering. Every group that wrote this test found the bug; the ones that
 * applied the sketch verbatim did not. The test is what found it, not the
 * review.
 */

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import { parseFailureDetail } from '../src/index.mjs'

function detailFor(document) {
  try {
    JSON.parse(document)
  } catch (error) {
    return parseFailureDetail(error)
  }
  throw new Error('the fixture parsed successfully, so it pins nothing')
}

const CREDENTIAL = 'AKIAIOSFODNN7EXAMPLE'
const NEWLINE = String.fromCharCode(10)
const NUL = String.fromCharCode(0)

describe('a parse failure never reproduces the document', () => {
  test('a document whose own text reads "at position 1"', () => {
    // V8 says: Unexpected token 'a', "at position 1" is not valid JSON.
    // A helper that looks for the offset first matches INSIDE the quoted span
    // and slices the document straight back out.
    const detail = detailFor('at position 1')
    assert.ok(!detail.includes('at position 1'), detail)
    assert.ok(!detail.includes('"'), detail)
    assert.equal(detail, "unexpected token 'a' at the start of the document")
  })

  test('a quoted span that carries a newline, which a non-dotAll pattern misses', () => {
    // The `s` flag on the quoting pattern is not decoration. V8's quoted run
    // is taken verbatim from the document, so it can contain a line break, and
    // `.` does not match one without the flag. Losing it does not leak here --
    // the closing backstop catches that -- but it does turn a specific answer
    // into the generic sentence, and nothing noticed.
    const document = `{ "k": ${NEWLINE}${CREDENTIAL}${NEWLINE}${CREDENTIAL} }`
    const detail = detailFor(document)
    assert.ok(!detail.includes(CREDENTIAL), detail)
    assert.ok(!detail.includes('"'), detail)
    assert.equal(detail, "unexpected token 'A' at the start of the document",
      'the quoting shape was not recognised, so the pattern is no longer dotAll')
  })

  test('and the same span quoted from the middle of the document', () => {
    const document = `{ "alpha": "ok", "beta": ${NEWLINE}${CREDENTIAL} }`
    const detail = detailFor(document)
    assert.ok(!detail.includes(CREDENTIAL), detail)
    assert.ok(!detail.includes('"'), detail)
    assert.match(detail, /^unexpected token /)
  })

  test('a document that is nothing but a credential', () => {
    const detail = detailFor(CREDENTIAL)
    assert.ok(!detail.includes(CREDENTIAL), detail)
    assert.ok(!detail.includes('AKIA'), detail)
  })

  test('a long document whose sensitive part is at the front', () => {
    const detail = detailFor(CREDENTIAL + 'z'.repeat(500))
    assert.ok(!detail.includes('AKIA'), detail)
    assert.ok(!detail.includes('zzzz'), detail)
  })

  test('a quoted span containing a newline', () => {
    // The `s` flag is what recognises this shape. Without it the pattern
    // silently fails to match and the document falls through to a branch that
    // may hand the span back.
    const detail = detailFor('{"alpha":' + NEWLINE + CREDENTIAL + '}')
    assert.ok(!detail.includes('AKIA'), detail)
    assert.ok(!detail.includes('"'), detail)
  })

  test('a quoted span taken from the middle of the document', () => {
    const detail = detailFor('{"alpha": "' + 'a'.repeat(40) + '", "beta": ' + CREDENTIAL + '}')
    assert.ok(!detail.includes('AKIA'), detail)
    assert.ok(!detail.includes('"'), detail)
  })

  test('the genuinely safe form still yields position, line and column', () => {
    // A helper that answered the generic sentence for everything would pass
    // every leak test while destroying the diagnostic it exists to give.
    const detail = detailFor('{"a":1,"b" 2}')
    assert.match(detail, /at position \d+/)
    assert.match(detail, /line \d+ column \d+/)
  })

  test('an empty document keeps its own wording', () => {
    assert.equal(detailFor(''), 'Unexpected end of JSON input')
  })

  test('a wording this helper has never seen falls back rather than leaking', () => {
    const detail = parseFailureDetail(new Error('Some future V8 wording about "secret-value" here'))
    assert.equal(detail, 'the document could not be parsed as JSON')
  })

  test('a message that reaches the position branch WITH a quote still in it', () => {
    // This is the case the closing guard exists for, and nothing else catches
    // it: the wording does not end in "is not valid JSON", so the quoting
    // branch declines it; the offset branch matches and would hand back a
    // slice that still carries the quoted run. The backstop sees the surviving
    // double quote and answers the generic sentence instead.
    const detail = parseFailureDetail(new Error('Unexpected token "' + CREDENTIAL + '" at position 5'))
    assert.ok(!detail.includes('AKIA'), detail)
    assert.equal(detail, 'the document could not be parsed as JSON')
  })

  test('a thrown value with no message at all is handled', () => {
    assert.equal(parseFailureDetail(undefined), 'the document could not be parsed as JSON')
    assert.equal(parseFailureDetail({ message: { toString: {} } }), 'the document could not be parsed as JSON')
  })
})

describe('across a sweep of documents, no double quote ever survives', () => {
  test('which is the property the closing guard actually enforces', () => {
    const documents = [
      'at position 1', 'at position 12', ' at position 1', 'at position 1' + NEWLINE,
      "'at position 1'", '}x' + NEWLINE, CREDENTIAL, '{"a": ' + CREDENTIAL + '}',
      '{"password":"hunter2"', '[1,2,', 'null null', '{"a":1}{"b":2}',
      '["' + 'x'.repeat(300) + '"', NUL, 'tru', '{"a" 1}',
    ]
    let checked = 0
    for (const document of documents) {
      let detail
      try {
        JSON.parse(document)
        continue
      } catch (error) {
        detail = parseFailureDetail(error)
      }
      checked += 1
      assert.ok(!detail.includes('"'), JSON.stringify(document) + ' leaked: ' + detail)
    }
    assert.equal(checked, documents.length, 'every fixture must actually fail to parse')
  })
})
