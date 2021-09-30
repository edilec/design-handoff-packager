/**
 * Refusing a destination that would write somewhere the caller did not name.
 *
 * This tool writes a whole directory, so every rule below applies to every one
 * of the files it writes and to every directory it creates on the way there.
 *
 * Three distinct holes, and each needs its own check because no one of them
 * catches the others. Measured across this catalog rather than imagined:
 * fifteen tools accepted a destination that destroyed a file they were never
 * asked to touch, and eight of them exited 0 reporting success. Closing one or
 * two holes is exactly why the survivor went unnoticed.
 *
 * 1. A SYMLINK AT THE DESTINATION writes wherever the link points, which may
 *    be anywhere on the machine. `realpath` on the destination does not help
 *    -- it resolves the link, and resolving is precisely the dangerous act.
 *    The link is refused on sight, by `lstat`, before anything is opened. This
 *    also covers a symlink to a path that does not exist yet, which otherwise
 *    CREATES a file outside the tree.
 * 2. A SYMLINKED PARENT does the same thing one level up, so the parent is
 *    resolved and checked against the root rather than compared lexically.
 *    Lexical comparison passes for `root/link/out` where `link` leaves the
 *    root. `mkdir` with `recursive: true` follows a symlinked parent exactly
 *    the same way, which is why `ensureDirectoryWithin` below creates one
 *    segment at a time and never calls it.
 * 3. A HARD LINK TO AN INPUT has no target to resolve and shares no path with
 *    it, so realpath and string comparison both say it is a different file. It
 *    is the same file. Only device plus inode sees that.
 *
 * `inputs` must be every file the run RESOLVED, not every file it opened, and
 * that distinction has already cost a repository file in this build. A planner
 * that only *names* the paths it reasons about passed just its plan and config
 * here, and a hard link sitting outside the root, sharing an inode with a
 * source file inside it, was written straight through: the parent resolved
 * where that tool required, the inode matched nothing in `inputs`, and the run
 * exited 0 saying the packet was written. Anything this tool stats, lists or
 * decides about belongs in `inputs`, and recording a path before reading it
 * costs nothing when the read then fails.
 */

import { lstat, mkdir, readdir, realpath, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'

/** Raised when a destination cannot be written to safely. The caller exits 2. */
export class DestinationError extends Error {
  constructor(message) {
    super(message)
    this.name = 'DestinationError'
  }
}

/**
 * Refuse an output file that would write somewhere the caller did not name, or
 * over something the caller is reading.
 *
 * `root` is optional and passing `null` is a real answer, not a shortcut: a
 * destination that is an arbitrary path the caller names has nothing for check
 * 2 to enforce, and inventing a root for it would refuse legitimate absolute
 * destinations -- including every run under the macOS temp directory, since
 * `/var` is a link to `/private/var`. Checks 1 and 3 still apply and still
 * matter. This tool passes the real `--out` directory for every file it writes
 * inside the package, and `null` for nothing at all; the `--out` directory
 * itself is handled by `prepareOutputRoot`, which documents what it does not
 * confine.
 */
export async function assertWritableDestination(destination, options = {}) {
  const { inputs = [], root = null, label = '--out', rootLabel = 'the permitted root' } = options
  const target = resolve(destination)

  let existing = null
  try {
    existing = await lstat(target)
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw new DestinationError(`${label} could not be inspected: ${error.code ?? 'unknown error'}`)
    }
  }

  if (existing !== null && existing.isSymbolicLink()) {
    throw new DestinationError(
      `${label} ${target} is a symbolic link. Writing through it would put the output `
      + 'wherever the link points, which is not the path you named, so it is refused. '
      + 'Name the real destination.',
    )
  }
  if (existing !== null && !existing.isFile()) {
    throw new DestinationError(`${label} ${target} exists and is not a regular file.`)
  }

  let parent
  try {
    parent = await realpath(dirname(target))
  } catch {
    throw new DestinationError(`${label} ${target} names a directory that does not exist.`)
  }

  if (root !== null) {
    const base = await realpath(resolve(root))
    if (parent !== base && !parent.startsWith(base + sep)) {
      throw new DestinationError(
        `${label} resolves to ${parent}, which is outside ${rootLabel}. `
        + 'A link or a ".." segment on the way there does not widen it.',
      )
    }
  }

  if (existing === null) return target

  // Same file as an input? Compare identity, not paths.
  for (const input of inputs) {
    let source
    try {
      source = await stat(input)
    } catch {
      continue
    }
    // A filesystem that reports no inode cannot answer this question, and an
    // unanswered identity question is not a "different file" answer.
    if (source.ino === 0 || existing.ino === 0) {
      throw new DestinationError(
        `${label} ${target} cannot be distinguished from an input: this filesystem reports `
        + 'no inode, so a hard link to a file being read cannot be ruled out.',
      )
    }
    if (source.dev === existing.dev && source.ino === existing.ino) {
      throw new DestinationError(
        `${label} ${target} is the same file as an input (they share device ${existing.dev} `
        + `and inode ${existing.ino}, so a hard link does not make them different files). `
        + 'This tool never rewrites what it reads.',
      )
    }
  }
  return target
}

/**
 * Create a directory inside an already-resolved base, one segment at a time.
 *
 * `mkdir(path, {recursive: true})` walks through a symlinked segment without
 * comment, which is hole 2 wearing a different hat: `out/link/states` creates
 * `states` wherever `link` points. Creating one segment at a time, with an
 * `lstat` before each, is the whole fix. `base` must already be a real path;
 * every segment below it is then verified not to be a link, so the returned
 * path is real without another `realpath` call.
 */
export async function ensureDirectoryWithin(base, segments) {
  let current = base
  for (const segment of segments) {
    current = join(current, segment)
    let info = null
    try {
      info = await lstat(current)
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw new DestinationError(`${current} could not be inspected: ${error.code ?? 'unknown error'}`)
      }
    }
    if (info === null) {
      await mkdir(current)
      continue
    }
    if (info.isSymbolicLink()) {
      throw new DestinationError(
        `${current} is a symbolic link, so creating the package inside it would write `
        + 'outside the directory you named. It is refused.',
      )
    }
    if (!info.isDirectory()) {
      throw new DestinationError(`${current} exists and is not a directory.`)
    }
  }
  return current
}

/**
 * Decide what `--out` resolves to, and refuse it, WITHOUT creating anything.
 *
 * Separated from `prepareOutputRoot` because creating the directory is itself
 * an effect on the filesystem, and the caller has one more question to answer
 * before it is allowed: does this destination overlap the tree being packaged?
 * Asking that after `mkdir` left an empty directory sitting inside the source
 * tree of a run that then exited 2 -- a modification to a tree the README says
 * is never modified.
 *
 * Returns `{target, real, exists}`. `real` is the path the directory will have
 * once it is created: the real path of its parent plus the last segment, which
 * is exactly what `realpath` would answer afterwards, because a symbolic link
 * AT the destination is refused here rather than resolved.
 */
export async function resolveOutputRoot(destination, options = {}) {
  const { label = '--out' } = options
  const target = resolve(destination)

  let existing = null
  try {
    existing = await lstat(target)
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw new DestinationError(`${label} could not be inspected: ${error.code ?? 'unknown error'}`)
    }
  }

  if (existing !== null && existing.isSymbolicLink()) {
    throw new DestinationError(
      `${label} ${target} is a symbolic link. The package would be written wherever the `
      + 'link points, which is not the path you named, so it is refused.',
    )
  }
  if (existing !== null && !existing.isDirectory()) {
    throw new DestinationError(`${label} ${target} exists and is not a directory.`)
  }
  if (existing !== null) return { target, real: await realpath(target), exists: true }

  let parent
  try {
    parent = await realpath(dirname(target))
  } catch {
    throw new DestinationError(
      `${label} ${target} names a parent directory that does not exist. `
      + 'Only the last segment is created, so that a mistyped path fails here rather '
      + 'than building a tree somewhere unexpected.',
    )
  }
  return { target, real: join(parent, basename(target)), exists: false }
}

/**
 * Settle the package directory before a single byte is written, and return its
 * real path.
 *
 * What this confines and what it does not, stated plainly because documenting
 * a confinement the code does not perform is worse than the silence it
 * replaces:
 *
 * - The directory itself is refused if it IS a symbolic link (hole 1), if it
 *   exists and is not a directory, or if it already holds entries and
 *   `allowNonEmpty` was not asked for.
 * - The directory itself is NOT confined to anything. It is an absolute or
 *   relative path the caller names, and a symbolically linked parent on the
 *   way to it is followed, exactly as `mkdir` and `cp` follow one. There is no
 *   root for it to escape from, and inventing one would refuse legitimate
 *   destinations.
 * - Only the last segment is created. A parent that does not exist is refused
 *   rather than conjured, so a mistyped path fails loudly instead of building
 *   a tree somewhere unexpected.
 * - Every file and every subdirectory written INSIDE it is confined to the
 *   real path returned here.
 *
 * This DOES create the directory, so a caller with a further reason to refuse
 * the destination must ask `resolveOutputRoot` first and refuse before getting
 * here.
 */
export async function prepareOutputRoot(destination, options = {}) {
  const { allowNonEmpty = false, label = '--out' } = options
  const settled = await resolveOutputRoot(destination, { label })

  if (!settled.exists) {
    try {
      await mkdir(settled.target)
    } catch (error) {
      throw new DestinationError(`${label} ${settled.target} could not be created: ${error.code ?? 'unknown error'}`)
    }
    return realpath(settled.target)
  }

  if (!allowNonEmpty) {
    const entries = await readdir(settled.target)
    if (entries.length > 0) {
      throw new DestinationError(
        `${label} ${settled.target} already holds ${entries.length} entr(ies). Pass --overwrite to `
        + 'write into it anyway; each file is still refused individually if it is a link '
        + 'or is one of the files being packaged.',
      )
    }
  }

  return settled.real
}
