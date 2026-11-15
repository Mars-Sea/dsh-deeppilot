import fs from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, posix, resolve, win32 } from 'node:path'
import type { DirectoryEntryLike, DirectoryListingLike } from './host-api.ts'

/** Read-only compatibility with DSH rc.3's dsh-host-directory-picker-browse
 * (src/index.ts): path fence, lexical crumbs, bounded sorted candidates and
 * symlink policy. Kept local so phone browsing never registers directoryPicker. */
export const PHONE_DIRECTORY_MAX_ENTRIES = 1000

/** Windows rooted paths still depend on the current drive; UNC needs a share. */
export function fullyQualified(path: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32'
    ? win32.isAbsolute(path) && /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/]+[^\\/]+)/.test(path)
    : posix.isAbsolute(path)
}

interface Candidate {
  name: string
  directory: boolean
}

/** Keep the stable localeCompare head using O(limit) memory and binary insertion. */
function retain(window: Candidate[], candidate: Candidate, keep: number): boolean {
  if (window.length === keep && candidate.name.localeCompare(window[keep - 1]!.name) >= 0) return true
  let lo = 0
  let hi = window.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (candidate.name.localeCompare(window[mid]!.name) < 0) hi = mid
    else lo = mid + 1
  }
  window.splice(lo, 0, candidate)
  if (window.length <= keep) return false
  window.pop()
  return true
}

/** Filesystem operations cannot be retracted; observe their late settlement too. */
function abortable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    operation.then(
      value => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      error => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  })
}

function unreadable(path: string, reason: unknown): Error & { code: string } {
  const message = reason instanceof Error ? reason.message : String(reason)
  return Object.assign(new Error(`cannot list ${path}: ${message}`), { code: 'directory-unreadable' })
}

function crumbs(target: string): DirectoryEntryLike[] {
  const result: DirectoryEntryLike[] = []
  for (let current = target; ;) {
    const parent = dirname(current)
    result.push({ name: parent === current ? current : basename(current), path: current, hidden: false })
    if (parent === current) return result.reverse()
    current = parent
  }
}

export async function listPhoneDirectory(path?: string, signal?: AbortSignal): Promise<DirectoryListingLike> {
  signal?.throwIfAborted()
  const home = homedir()
  if (path !== undefined && !fullyQualified(path)) {
    throw unreadable(path, 'not a fully qualified path')
  }
  // resolve is lexical: following a directory symlink must retain its visible path.
  const target = resolve(path ?? home)
  const window: Candidate[] = []
  let evicted = false
  try {
    const opening = fs.opendir(target)
    const level = await abortable(opening, signal).catch(error => {
      // An aborted opendir can still return a handle later. Give that handle an owner.
      void opening.then(dir => dir.close().catch(() => {}), () => {})
      throw error
    })
    try {
      for (;;) {
        signal?.throwIfAborted()
        const entry = await abortable(level.read(), signal)
        if (!entry) break
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
        evicted = retain(window, { name: entry.name, directory: entry.isDirectory() }, PHONE_DIRECTORY_MAX_ENTRIES + 1) || evicted
      }
    } finally {
      // Node queues close behind a pending read; an aborted caller must not wait
      // for either. Race close as well if cancellation arrives during normal close.
      await abortable(level.close(), signal)
    }
  } catch (error) {
    signal?.throwIfAborted()
    throw unreadable(target, error)
  }

  const entries: DirectoryEntryLike[] = []
  let truncated = evicted
  for (const candidate of window) {
    signal?.throwIfAborted()
    const child = join(target, candidate.name)
    if (!candidate.directory) {
      try {
        if (!(await abortable(fs.stat(child), signal)).isDirectory()) continue
      } catch {
        signal?.throwIfAborted()
        continue // Broken, looping or unreadable symlinks are not enterable.
      }
    }
    if (entries.length === PHONE_DIRECTORY_MAX_ENTRIES) {
      truncated = true
      break
    }
    entries.push({ name: candidate.name, path: child, hidden: candidate.name.startsWith('.') })
  }
  signal?.throwIfAborted()
  // Match rc.3: non-enterable candidates in the bounded window are not backfilled;
  // eviction still honestly reports a truncated scan even if fewer rows survive.
  return { path: target, home, crumbs: crumbs(target), entries, truncated }
}
