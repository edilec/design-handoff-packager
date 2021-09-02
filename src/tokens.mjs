/**
 * Flattening a design-token document into the names a component may cite.
 *
 * The shape is the one the token-file conventions in wide use share: nested
 * groups, and a leaf recognised by a `$value` (the DTCG spelling) or a `value`
 * (the older spelling) member. `color.brand.primary` is the dotted path to
 * that leaf. Nothing here resolves aliases, computes a value or renders one --
 * this tool checks that a citation points at a token that exists, and says so.
 */

import { byCodeUnit } from './text.mjs'

const VALUE_KEYS = Object.freeze(['$value', 'value'])

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isLeaf(node) {
  return VALUE_KEYS.some((key) => Object.hasOwn(node, key))
}

/**
 * Collect every token name declared by a document.
 *
 * Returns `{names, truncated, tooDeep}`. `truncated` and `tooDeep` are the two
 * ways this can stop early, and neither is ever a pass: the caller turns each
 * into an `incomplete` report naming the limit it hit. A token set that was
 * only partly read cannot answer "is this citation resolved?" -- absence of a
 * name in a partial set is not evidence that the name is absent.
 *
 * Order is by code unit, so a manifest lists the same names in the same order
 * on every machine. Object key order is not consulted for anything but the
 * walk itself.
 */
export function flattenTokens(document, limits) {
  const { maxTokensPerDocument, maxTokenDepth } = limits
  const names = []
  let truncated = false
  let tooDeep = false

  const walk = (node, path, depth) => {
    if (truncated) return
    if (depth > maxTokenDepth) {
      tooDeep = true
      return
    }
    if (!isRecord(node)) return
    if (isLeaf(node)) {
      if (path.length === 0) return
      if (names.length >= maxTokensPerDocument) {
        truncated = true
        return
      }
      names.push(path.join('.'))
      return
    }
    for (const key of Object.keys(node).sort(byCodeUnit)) {
      if (key.startsWith('$')) continue
      walk(node[key], [...path, key], depth + 1)
      if (truncated) return
    }
  }

  walk(document, [], 1)
  names.sort(byCodeUnit)
  return { names, truncated, tooDeep }
}
