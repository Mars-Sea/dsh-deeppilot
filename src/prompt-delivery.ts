import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, mkdirSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, statSync } from 'node:fs'
import { dirname } from 'node:path'

export type DeliveryStatus = 'accepted' | 'rejected' | 'unknown' | 'notFound' | 'expired'
export interface DeliveryReceipt { clientSendId: string; status: DeliveryStatus; userSeq?: number; code?: string }
interface Entry { fingerprint: string; sessionId: string; createdAt: number; receipt: DeliveryReceipt }
export const DELIVERY_RETENTION_MS = 7 * 24 * 3600 * 1000
export function validSendId(id: unknown): id is string {
  return typeof id === 'string' && /^\d{13}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
}

/** Durable at-most-once dispatch. Unknown outcomes are never automatically retried. */
export class PromptDeliveryJournal {
  private entries: Record<string, Entry> = Object.create(null)
  private inFlight = new Map<string, Promise<DeliveryReceipt>>()
  private healthy = true
  constructor(private readonly path?: string, private readonly capacity = 10000) {
    if (!path || !existsSync(path)) return
    try {
      if (statSync(path).size > 8 * 1024 * 1024) throw new Error('oversized journal')
      const parsed = JSON.parse(readFileSync(path, 'utf8'))
      if (parsed.version !== 1 || !Array.isArray(parsed.entries) || parsed.entries.length > capacity) throw new Error('invalid journal')
      for (const [key, value] of parsed.entries) {
        if (typeof key !== 'string' || !/^[a-f0-9]{64}$/.test(key) || !value || typeof value.sessionId !== 'string' || !Number.isFinite(value.createdAt) || typeof value.fingerprint !== 'string' || !validSendId(value.receipt?.clientSendId) || !['accepted', 'rejected', 'unknown'].includes(value.receipt.status)) throw new Error('invalid entry')
        if (!/^[a-f0-9]{64}$/.test(value.fingerprint) || value.createdAt !== Number(value.receipt.clientSendId.slice(0, 13)) || (value.receipt.status === 'accepted' && !Number.isSafeInteger(value.receipt.userSeq)) || (value.receipt.status === 'rejected' && !['E_BUSY', 'E_NOT_FOUND', 'E_PROTOCOL', 'E_UNSUPPORTED'].includes(value.receipt.code))) throw new Error('invalid receipt')
        this.entries[key] = value
      }
    } catch { this.healthy = false }
  }
  private key(deviceId: string, id: string) { return createHash('sha256').update(JSON.stringify([deviceId, id])).digest('hex') }
  private expired(id: string, now = Date.now()) { const age = now - Number(id.slice(0, 13)); return age > DELIVERY_RETENTION_MS || age < -5 * 60 * 1000 }
  private save() {
    if (!this.path) return
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    const temp = this.path + '.' + randomUUID() + '.tmp'
    const fd = openSync(temp, 'wx', 0o600)
    try { writeFileSync(fd, JSON.stringify({ version: 1, entries: Object.entries(this.entries) })); fsyncSync(fd) } finally { closeSync(fd) }
    renameSync(temp, this.path)
    const dir = openSync(dirname(this.path), 'r')
    try { fsyncSync(dir) } finally { closeSync(dir) }
  }
  lookup(deviceId: string, sessionId: string, id: string): DeliveryReceipt {
    if (!this.healthy) return { clientSendId: id, status: 'unknown' }
    const entry = this.entries[this.key(deviceId, id)]
    if (entry && entry.sessionId === sessionId) return entry.receipt
    return { clientSendId: id, status: this.expired(id) ? 'expired' : 'notFound' }
  }
  async dispatch(deviceId: string, sessionId: string, id: string, content: unknown, operation: () => Promise<{ ok: true; value: number } | { ok: false; kind: string }>): Promise<DeliveryReceipt> {
    const key = this.key(deviceId, id)
    const fingerprint = createHash('sha256').update(JSON.stringify([sessionId, content])).digest('hex')
    const existing = this.entries[key]
    if (existing) {
      if (existing.fingerprint !== fingerprint) return { clientSendId: id, status: 'rejected', code: 'E_PROTOCOL' }
      return this.inFlight.get(key) ?? existing.receipt
    }
    if (!this.healthy) return { clientSendId: id, status: 'unknown' }
    if (this.expired(id)) return { clientSendId: id, status: 'expired' }
    for (const [key, value] of Object.entries(this.entries)) {
      if (Date.now() - value.createdAt > DELIVERY_RETENTION_MS + 5 * 60 * 1000 && !this.inFlight.has(key)) delete this.entries[key]
    }
    if (Object.keys(this.entries).length >= this.capacity) return { clientSendId: id, status: 'rejected', code: 'E_BUSY' }
    const entry: Entry = { fingerprint, sessionId, createdAt: Number(id.slice(0, 13)), receipt: { clientSendId: id, status: 'unknown' } }
    this.entries[key] = entry
    try { this.save() } catch { this.healthy = false; return entry.receipt }
    const run = (async () => {
      try {
        const result = await operation()
        if (result.ok) entry.receipt = { clientSendId: id, status: 'accepted', userSeq: result.value }
        else if (['busy', 'not-found', 'invalid', 'unsupported'].includes(result.kind)) {
          const code = { busy: 'E_BUSY', 'not-found': 'E_NOT_FOUND', invalid: 'E_PROTOCOL', unsupported: 'E_UNSUPPORTED' }[result.kind]!
          entry.receipt = { clientSendId: id, status: 'rejected', code }
        }
      } catch { /* Upstream may have accepted before transport failed. */ }
      try { this.save() } catch { this.healthy = false }
      return entry.receipt
    })()
    this.inFlight.set(key, run)
    try { return await run } finally { this.inFlight.delete(key) }
  }
}

const journals = new Map<string, PromptDeliveryJournal>()
export function openDeliveryJournal(path?: string): PromptDeliveryJournal {
  if (!path) return new PromptDeliveryJournal()
  let journal = journals.get(path)
  if (!journal) { journal = new PromptDeliveryJournal(path); journals.set(path, journal) }
  return journal
}
