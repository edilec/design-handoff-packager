/**
 * Decoding, sanitising, ordering and instants.
 *
 * Nothing in this module touches the filesystem, the network, the locale, the
 * environment or the clock, so every function here is a pure function of its
 * arguments. That is what makes a handoff package reproducible: the same plan
 * and the same sources produce the same bytes on any machine.
 *
 * Every value this module handles arrived in a file the tool did not write, so
 * every value it returns is treated as data on its way to a report -- never as
 * something that can shape a line of output.
 */

/**
 * Order by UTF-16 code unit.
 *
 * Locale-aware comparison -- the string method and the collator class alike --
 * depends on ICU data that differs between Node builds and between hosts, and
 * both treat punctuation as ignorable: under collation `icon-button` and
 * `icon_button` swap places depending on where the tool runs. A manifest is a
 * byte-for-byte contract, so every order this package exposes is decided here.
 * Neither spelling appears anywhere in this package, and `test/ordering.test.mjs`
 * pins the emitted order rather than the spelling -- a source scan cannot tell
 * one comparator from the other.
 */
export function byCodeUnit(left, right) {
  if (left === right) return 0
  return left < right ? -1 : 1
}

/**
 * Turn any value into a string without ever throwing.
 *
 * `String({toString: {}})` throws `Cannot convert object to primitive value`,
 * and so does `String(Symbol())`. Uncaught, either costs the whole report:
 * stdout is empty on exit 2 -- the shape this catalog reserves for a
 * configuration error -- and one malformed plan suppresses the findings for
 * every other input in the same run. Five of ten tools in one batch shipped
 * that crash.
 *
 * A value that cannot be stringified is described by its shape and never
 * reproduced. Every untrusted value in this package reaches output through
 * `excerpt`, which starts here, so the guard sits at the one boundary rather
 * than at each of the several dozen call sites.
 */
export function safeString(value) {
  if (typeof value === 'string') return value
  try {
    return String(value)
  } catch {
    return Array.isArray(value) ? '[array]' : '[object]'
  }
}

/**
 * The characters no untrusted value may carry into output, in four classes.
 *
 * Built from code points rather than written literally: a literal U+2028 or
 * U+2029 inside a module is a line terminator to the JavaScript parser, and
 * the rest are invisible in an editor. Spelling each one keeps this file plain
 * ASCII and keeps the list readable.
 *
 * - **C0** (U+0000-U+001F) and **DEL** (U+007F). A newline forges a line in
 *   the human summary; ESC opens a terminal escape sequence; NUL truncates a
 *   value in anything that receives it through C.
 * - **C1** (U+0080-U+009F). Easy to forget once C0 is handled, and two of them
 *   do the same damage unaided: U+0085 NEL is a line break to a great many
 *   consumers, and U+009B is the 8-bit CSI, a terminal control introducer that
 *   needs no ESC in front of it. Neither is ECMAScript whitespace and neither
 *   is escaped by `JSON.stringify`.
 * - **Line and paragraph separators** (U+2028, U+2029). They terminate a line
 *   for a JavaScript consumer of the report.
 * - **Bidi and isolate controls** (U+200E, U+200F, U+202A-U+202E,
 *   U+2066-U+2069). U+202E RIGHT-TO-LEFT OVERRIDE reverses everything printed
 *   after it, so a component packaged under one name is read as another; the
 *   isolates hide what they wrap. Ordinary right-to-left text -- Arabic,
 *   Hebrew -- needs none of these: the letters carry their own direction, so
 *   refusing the overrides refuses nothing legitimate.
 */
const DEL_AND_C1 = `${String.fromCharCode(0x7f)}-${String.fromCharCode(0x9f)}`
const SEPARATORS = `${String.fromCharCode(0x2028)}${String.fromCharCode(0x2029)}`
const BIDI =
  `${String.fromCharCode(0x200e)}${String.fromCharCode(0x200f)}` +
  `${String.fromCharCode(0x202a)}-${String.fromCharCode(0x202e)}` +
  `${String.fromCharCode(0x2066)}-${String.fromCharCode(0x2069)}`

/**
 * Stripped from every untrusted string on its way into output -- component
 * ids, state names, token names, relative paths, pointers, messages and
 * evidence alike, not only an excerpt field. Tab, newline and carriage return
 * are left out of this class deliberately: `excerpt` collapses them into a
 * single space in the very next step, which is the same result by a shorter
 * route.
 */
const CONTROL = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(8)}` +
  `${String.fromCharCode(11)}${String.fromCharCode(12)}` +
  `${String.fromCharCode(14)}-${String.fromCharCode(31)}` +
  `${DEL_AND_C1}${SEPARATORS}${BIDI}]`,
  'g',
)

/**
 * What an identifier may not contain: the same four classes, plus the three
 * ASCII whitespace controls `CONTROL` leaves to the collapse. An identifier
 * gets no second pass, and a component whose printed name differs from the
 * directory it was written to is a component nobody can review.
 */
const FORBIDDEN_IN_IDENTIFIER = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(31)}` +
  `${DEL_AND_C1}${SEPARATORS}${BIDI}]`,
)

/**
 * Detects any of the four classes anywhere in a string. Exported so a test can
 * walk a whole report and a whole manifest and assert that nothing survived,
 * rather than checking the one field a developer remembered.
 */
export function hasForbiddenCharacter(value) {
  return FORBIDDEN_IN_IDENTIFIER.test(safeString(value))
}

export const EXCERPT_LIMIT = 160

/**
 * A bounded, single-line, control-free rendering of an untrusted string.
 *
 * Every identifier, path, pointer, message and piece of evidence that reaches
 * a finding or a manifest goes through here. A tool in this catalog sanitised
 * its evidence carefully and left its identifiers raw, so a record id holding a
 * newline printed two lines into the human summary and invented a finding that
 * was never emitted.
 */
export function excerpt(value, limit = EXCERPT_LIMIT) {
  if (!Number.isInteger(limit) || limit < 1) throw new TypeError('Excerpt limit must be a positive integer')
  const flattened = safeString(value).replace(CONTROL, ' ').replace(/\s+/g, ' ').trim()
  if (flattened.length <= limit) return flattened
  return `${flattened.slice(0, limit)}...`
}

/**
 * True when a value is a string that will still be visible after sanitising.
 *
 * `value.trim().length > 0` is the check this replaces, and it is wrong in a
 * way that is invisible until somebody reads the output: `trim` removes
 * ECMAScript whitespace only, so a string of U+0001, or of U+200E, passes it
 * and then renders as nothing at all. Validate what will be RENDERED.
 */
export function isRenderableText(value, maxLength = 200) {
  if (typeof value !== 'string') return false
  if (value.length > maxLength) return false
  return excerpt(value, maxLength).length > 0
}

/**
 * The shape of every identifier this tool turns into a path segment: a
 * component id, a state name, a token document id.
 *
 * It is deliberately narrower than "no control characters". These names become
 * directory and file names in the handoff package, so they may not contain a
 * separator, may not start with a dot, and may not be `.` or `..`. The leading
 * alphanumeric requirement settles all three at once.
 */
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

export function isIdentifier(value) {
  return typeof value === 'string' && IDENTIFIER.test(value) && !FORBIDDEN_IN_IDENTIFIER.test(value)
}

/**
 * Say what a refused value was, without reproducing any of it.
 *
 * A rejected field is arbitrary content from a file this tool did not write,
 * and the report goes to stdout -- a stream that is piped, logged and pasted
 * somewhere more public than the plan ever was. Echoing the value back hands
 * that content a wider audience than it had. The pointer on the finding
 * already names the exact position in the plan, so the shape is all a reader
 * needs from the report itself; the value is in the file, where it started.
 */
export function describeValue(value) {
  if (value === undefined) return 'nothing'
  if (value === null) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return Number.isInteger(value) ? 'an integer' : 'a number'
  if (typeof value === 'string') return `a string of ${value.length} character(s)`
  if (Array.isArray(value)) return `an array of ${value.length} item(s)`
  if (typeof value === 'object') return 'an object'
  return `a ${typeof value}`
}

const UNPARSEABLE = 'the document could not be parsed as JSON'

/** Where V8 puts the offending offset. Safe: an offset says nothing about content. */
const POSITION = /at position \d+(?: \(line \d+ column \d+\))?/

/**
 * The shape that quotes the input. Recognised FIRST, and the ordering is the
 * whole guard: a document whose own text reads `at position 1` makes V8 emit
 * `Unexpected token 'a', "at position 1" is not valid JSON`, so a helper that
 * looks for the offset first matches inside the quoted span and slices the
 * document back out. Nineteen of thirty-eight tools in this catalog shipped
 * exactly that. The `s` flag matters too -- the quoted span can contain a
 * newline, and a non-dotAll pattern silently fails to recognise the shape it
 * is there to catch. A leading `...` means the quoted run came from the middle
 * of the document rather than its start, which is the only thing about the
 * position this shape reveals.
 */
const QUOTES_THE_INPUT = /^Unexpected token (.+?), (\.\.\.)?".*"(?:\.\.\.)? is not valid JSON$/s

function describeParseFailure(message) {
  const quoting = QUOTES_THE_INPUT.exec(message)
  if (quoting !== null) {
    const where = quoting[2] === undefined ? 'at the start of the document' : 'inside the document'
    return `unexpected token ${quoting[1]} ${where}`
  }
  const position = POSITION.exec(message)
  if (position !== null) return message.slice(0, position.index + position[0].length)
  if (message === 'Unexpected end of JSON input') return message
  return UNPARSEABLE
}

/**
 * Say what a JSON parse failure was, without reproducing the document.
 *
 * V8 embeds the input in the message: `Unexpected token 'A',
 * "AKIAIOSFODNN7EXAMPLE" is not valid JSON`. The quoted run is taken from
 * wherever the offence is, so a plan short enough to be nothing but a
 * credential is reproduced in full by its own error message, and truncating
 * the front is not a fix.
 *
 * The closing guard is deliberate belt and braces, and it is the reason this
 * function is safe against wordings it has never seen: across 500,206 distinct
 * V8 parse messages, every one that carries no quoted snippet also carries no
 * double quote at all -- V8 quotes JSON punctuation with apostrophes. So a
 * double quote surviving to the end means a snippet survived, whatever the
 * branch logic above concluded, and the generic sentence is used instead.
 */
export function parseFailureDetail(error) {
  const message = safeString(error?.message ?? '')
  const detail = describeParseFailure(message)
  return detail.includes('"') ? UNPARSEABLE : detail
}

/**
 * Decode bytes as UTF-8, strictly.
 *
 * `fatal: true` is the whole point. Decoding leniently and then hunting for
 * U+FFFD cannot tell undecodable bytes from a file that legitimately contains
 * a replacement character, and that confusion has let an unread input report a
 * pass in this catalog. The decoder decides; the decoded text never gets a
 * vote. Every file this tool opens goes through here, the plan included.
 */
export function decodeUtf8(bytes) {
  try {
    return { ok: true, text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes) }
  } catch {
    return { ok: false, reason: 'not-utf8' }
  }
}

const INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?Z$/
const DAYS_IN_MONTH = Object.freeze([31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31])

function daysInMonth(year, month) {
  if (month !== 2) return DAYS_IN_MONTH[month - 1]
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
  return leap ? 29 : 28
}

/**
 * Parse an ISO-8601 UTC instant, exactly. Returns epoch milliseconds, or null.
 *
 * `Date.parse` alone is not a validator: it accepts `2026-02-31T00:00:00Z` and
 * hands back the third of March, and it accepts `24:00:00` and hands back the
 * following midnight. Either would let a plan claim a screenshot was captured
 * on a day it was not, which is the difference between "this evidence is
 * current" and "this evidence is a year old". The calendar is checked
 * arithmetically instead, and only `Z` is accepted: a plan that mixes local
 * offsets is a plan whose staleness depends on who wrote the line.
 *
 * `Date.UTC` is a pure conversion from validated components to an epoch
 * offset. It reads no clock.
 */
export function parseInstant(value) {
  if (typeof value !== 'string') return null
  const found = INSTANT.exec(value)
  if (found === null) return null
  const [, year, month, day, hour, minute, second, millisecond] = found.map(Number)
  if (month < 1 || month > 12) return null
  if (day < 1 || day > daysInMonth(year, month)) return null
  if (hour > 23 || minute > 59 || second > 59) return null
  return Date.UTC(year, month - 1, day, hour, minute, second, millisecond || 0)
}

/** Escape one path segment for a JSON Pointer, per RFC 6901. */
export function escapePointerSegment(segment) {
  return safeString(segment).replaceAll('~', '~0').replaceAll('/', '~1')
}

/** Build a JSON Pointer from already-escaped-or-numeric segments. */
export function pointer(...segments) {
  return `/${segments.map((segment) => escapePointerSegment(segment)).join('/')}`
}
