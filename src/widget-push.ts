/** Coalesce bursts and bound continuous updates, without starving the trailing
 * state. One scheduler per host, not per token or per streaming text frame. */
export class WidgetPushScheduler {
  private timer?: ReturnType<typeof setTimeout>
  private lastSent = 0
  private disposed = false
  private sending = false
  private dirty = false

  constructor(private readonly send: () => Promise<void>, private readonly intervalMs = 30_000) {}

  changed(): void {
    if (this.disposed) return
    this.dirty = true
    if (this.timer || this.sending) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.dirty = false
      this.sending = true
      this.lastSent = Date.now()
      void this.send().catch(() => {}).finally(() => {
        this.sending = false
        if (this.dirty) this.changed()
      })
    }, Math.max(Math.min(1000, this.intervalMs), this.intervalMs - (Date.now() - this.lastSent)))
    this.timer.unref()
  }

  dispose(): void {
    this.disposed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
  }
}
