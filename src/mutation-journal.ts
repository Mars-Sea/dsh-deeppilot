import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, mkdirSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { validSendId } from './prompt-delivery.ts'

export type MutationErrorCode =
  | 'E_PROTOCOL'
  | 'E_NOT_FOUND'
  | 'E_BUSY'
  | 'E_UNSUPPORTED'
  | 'E_INTERNAL'

export type MutationOperationResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: MutationErrorCode; message?: string }

export type MutationDispatchResult<T> =
  | { ok: true; value?: T; replayed?: boolean }
  | { ok: false; code: MutationErrorCode; message?: string; replayed?: boolean }

interface PersistedReceipt {
  fingerprint: string
  createdAt: number
  status: 'accepted' | 'rejected' | 'unknown'
  code?: MutationErrorCode
}

interface Entry extends PersistedReceipt {
  /** Only non-sensitive replay values, enabled for fork session ids. */
  value?: unknown
}

const RETENTION_MS = 7 * 24 * 3600 * 1000
const CAPACITY = 10_000

/**
 * Small durable at-most-once journal for non-prompt mutations.
 *
 * Only a hash of the request content is persisted. The successful value is
 * kept in memory for the current process so a concurrent retry can receive the
 * same response; after a restart a replay is acknowledged and the client
 * refetches the authoritative resource. This avoids duplicating reminder
 * prompts or conversation data in a second journal.
 */
export class MutationJournal {
  private readonly entries: Record<string, Entry> = Object.create(null)
  private readonly inFlight = new Map<string, Promise<MutationDispatchResult<unknown>>>()
  private healthy = true

  constructor(private readonly path?: string, private readonly persistValues = false) {
    if (!path || !existsSync(path)) return
    try {
      if (statSync(path).size > 4 * 1024 * 1024) throw new Error('oversized mutation journal')
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown; entries?: unknown }
      if (parsed.version !== 1 || !Array.isArray(parsed.entries) || parsed.entries.length > CAPACITY) {
        throw new Error('invalid mutation journal')
      }
      for (const value of parsed.entries) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid mutation entry')
        const entry = value as Record<string, unknown>
        if (typeof entry.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(entry.fingerprint) ||
            typeof entry.createdAt !== 'number' || !Number.isFinite(entry.createdAt) ||
            !['accepted', 'rejected', 'unknown'].includes(String(entry.status))) throw new Error('invalid mutation entry')
        if (entry.status === 'rejected' && !isMutationErrorCode(entry.code)) throw new Error('invalid mutation code')
        const key = String((value as { key?: unknown }).key)
        if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('invalid mutation key')
        this.entries[key] = {
          fingerprint: entry.fingerprint,
          createdAt: entry.createdAt,
          status: entry.status as PersistedReceipt['status'],
          ...(isMutationErrorCode(entry.code) ? { code: entry.code } : {}),
          ...(this.persistValues && entry.value !== undefined ? { value: entry.value } : {}),
        }
      }
    } catch {
      this.healthy = false
    }
  }

  private key(deviceId: string, id: string): string {
    return createHash('sha256').update(JSON.stringify([deviceId, id])).digest('hex')
  }

  private expired(id: string, now = Date.now()): boolean {
    const age = now - Number(id.slice(0, 13))
    return age > RETENTION_MS || age < -5 * 60 * 1000
  }

  private save(): void {
    if (!this.path) return
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    const temp = this.path + '.' + randomUUID() + '.tmp'
    const fd = openSync(temp, 'wx', 0o600)
    try {
      writeFileSync(fd, JSON.stringify({
        version: 1,
        entries: Object.entries(this.entries).map(([key, entry]) => ({ key, ...entry })),
      }))
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(temp, this.path)
    const dir = openSync(dirname(this.path), 'r')
    try { fsyncSync(dir) } finally { closeSync(dir) }
  }

  async dispatch<T>(
    deviceId: string,
    id: string,
    content: unknown,
    operation: () => Promise<MutationOperationResult<T>>,
  ): Promise<MutationDispatchResult<T>> {
    if (!validSendId(id)) return { ok: false, code: 'E_PROTOCOL', message: 'invalid clientRequestId' }
    const key = this.key(deviceId, id)
    const fingerprint = createHash('sha256').update(JSON.stringify(content)).digest('hex')
    const existing = this.entries[key]
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) {
        return { ok: false, code: 'E_PROTOCOL', message: 'clientRequestId was reused with different content', replayed: true }
      }
      if (existing.status === 'accepted') return { ok: true, value: existing.value as T | undefined, replayed: true }
      if (existing.status === 'rejected' && existing.code !== undefined) {
        return { ok: false, code: existing.code, replayed: true }
      }
      return { ok: false, code: 'E_INTERNAL', message: 'mutation outcome is unknown; do not retry automatically', replayed: true }
    }
    if (!this.healthy) return { ok: false, code: 'E_INTERNAL', message: 'mutation journal unavailable' }
    if (this.expired(id)) return { ok: false, code: 'E_PROTOCOL', message: 'clientRequestId is outside the retry window' }

    const now = Date.now()
    for (const [entryKey, entry] of Object.entries(this.entries)) {
      if (now - entry.createdAt > RETENTION_MS + 5 * 60 * 1000 && !this.inFlight.has(entryKey)) {
        delete this.entries[entryKey]
      }
    }
    if (Object.keys(this.entries).length >= CAPACITY) {
      return { ok: false, code: 'E_BUSY', message: 'mutation journal is full' }
    }

    const entry: Entry = { fingerprint, createdAt: Number(id.slice(0, 13)), status: 'unknown' }
    this.entries[key] = entry
    try { this.save() } catch {
      this.healthy = false
      return { ok: false, code: 'E_INTERNAL', message: 'mutation journal could not persist the request' }
    }

    const run = (async (): Promise<MutationDispatchResult<unknown>> => {
      try {
        const result = await operation()
        if (result.ok) {
          entry.status = 'accepted'
          if (this.persistValues) entry.value = result.value
          return result
        }
        entry.status = 'rejected'
        entry.code = result.code
        return { ok: false, code: result.code, message: result.message }
      } catch {
        return { ok: false, code: 'E_INTERNAL', message: 'mutation outcome is unknown; do not retry automatically' }
      } finally {
        try { this.save() } catch { this.healthy = false }
      }
    })()
    this.inFlight.set(key, run)
    try {
      return await run as MutationDispatchResult<T>
    } finally {
      this.inFlight.delete(key)
    }
  }
}

function isMutationErrorCode(value: unknown): value is MutationErrorCode {
  return typeof value === 'string' && ['E_PROTOCOL', 'E_NOT_FOUND', 'E_BUSY', 'E_UNSUPPORTED', 'E_INTERNAL'].includes(value)
}

const journals = new Map<string, MutationJournal>()
export function openMutationJournal(path?: string, persistValues = false): MutationJournal {
  if (!path) return new MutationJournal(undefined, persistValues)
  let journal = journals.get(path)
  if (!journal) { journal = new MutationJournal(path, persistValues); journals.set(path, journal) }
  return journal
}
