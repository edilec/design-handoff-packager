/**
 * Finding the links a usage note makes.
 *
 * "All internal links resolve" is one of this tool's three promises, and a
 * usage note is where most of them live: a note that points at an anatomy
 * diagram, a sibling component's note or a token file is making a claim about
 * the package that is about to be handed over.
 *
 * What is recognised, stated precisely because an overclaim in a document is
 * counted as a defect here:
 *
 * - Inline links and inline images, `[text](target)` and `![alt](target)`,
 *   outside fenced code blocks and outside inline code spans.
 * - An optional title after the target, `[text](target "Title")`, is skipped.
 * - An angle-bracketed target, `[text](<a b.md>)`, is unwrapped.
 *
 * What is NOT recognised, and is therefore not checked -- these are non-goals,
 * not gaps this tool pretends to cover:
 *
 * - Reference-style links (`[text][ref]` with a `[ref]: target` definition).
 * - Autolinks (`<https://example.com>`) and bare URLs.
 * - HTML anchors and image tags inside the Markdown.
 * - Anything inside an indented (four-space) code block.
 */

const FENCE = /^\s{0,3}(```+|~~~+)/
const INLINE_LINK = /(!?)\[(?:[^\[\]\\]|\\.)*\]\(\s*([^()\s]*|<[^<>]*>)(?:\s+(?:"[^"]*"|'[^']*'|\([^()]*\)))?\s*\)/g

/** Strip inline code spans, so a backticked path is not mistaken for a link. */
function withoutCodeSpans(line) {
  return line.replace(/`+[^`]*`+/g, (run) => ' '.repeat(run.length))
}

/**
 * Every inline link target in a Markdown document, with the 1-based line it
 * was written on.
 *
 * Stops at `maxLinks` and reports that it did. A note whose links were only
 * partly read cannot answer "do all the links resolve?", so the caller turns
 * `truncated` into an `incomplete` report rather than a pass.
 */
export function extractLinks(markdown, maxLinks) {
  const links = []
  let truncated = false
  let fence = null

  const lines = markdown.split(/\r\n|\r|\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const fenceStart = FENCE.exec(line)
    if (fenceStart !== null) {
      if (fence === null) fence = fenceStart[1][0]
      else if (fenceStart[1][0] === fence) fence = null
      continue
    }
    if (fence !== null) continue

    INLINE_LINK.lastIndex = 0
    let found = INLINE_LINK.exec(withoutCodeSpans(line))
    while (found !== null) {
      if (links.length >= maxLinks) return { links, truncated: true }
      const raw = found[2]
      const target = raw.startsWith('<') && raw.endsWith('>') ? raw.slice(1, -1) : raw
      links.push({ target, line: index + 1, image: found[1] === '!' })
      found = INLINE_LINK.exec(withoutCodeSpans(line))
    }
  }
  return { links, truncated }
}

/**
 * How a link target should be treated.
 *
 * `fragment` is a link within the same document and needs no file to exist.
 * `external` carries a scheme; this tool never fetches one, and says so in the
 * report rather than silently ignoring it. `relative` is the one that has to
 * resolve to a file inside the root.
 */
export function classifyTarget(target) {
  if (target === '') return 'empty'
  if (target.startsWith('#')) return 'fragment'
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return 'external'
  if (target.startsWith('//')) return 'external'
  return 'relative'
}
