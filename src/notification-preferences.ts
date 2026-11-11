import type { NotificationPreferences, NotifyCategory } from './protocol.ts'

/**
 * Sound and quiet hours govern completion notices only. Approvals, questions
 * and failures block or end work, so they are always delivered, with sound.
 */
export function isCompletionCategory(category: NotifyCategory): boolean {
  return category === 'turn.completed' || category === 'goal.completed'
}

/** Validate once at the wire/storage boundary; invalid time zones never become host-local time. */
export function isNotificationPreferences(value: unknown): value is NotificationPreferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const p = value as Record<string, unknown>
  if (typeof p.soundEnabled !== 'boolean') return false
  if (p.quietHours === undefined) return true
  const q = p.quietHours as Record<string, unknown> | null
  if (!q || typeof q !== 'object' || Array.isArray(q) || typeof q.enabled !== 'boolean' ||
      !Number.isInteger(q.startMinutes) || (q.startMinutes as number) < 0 || (q.startMinutes as number) >= 1440 ||
      !Number.isInteger(q.endMinutes) || (q.endMinutes as number) < 0 || (q.endMinutes as number) >= 1440 ||
      typeof q.timeZone !== 'string' || !q.timeZone || q.timeZone.length > 128 || /^[+-]/.test(q.timeZone)) return false
  try { new Intl.DateTimeFormat('en-US', { timeZone: q.timeZone }).format(0); return true } catch { return false }
}

export function notificationPreferences(value: NotificationPreferences): NotificationPreferences {
  return { soundEnabled: value.soundEnabled, ...(value.quietHours ? { quietHours: {
    enabled: value.quietHours.enabled, startMinutes: value.quietHours.startMinutes,
    endMinutes: value.quietHours.endMinutes, timeZone: value.quietHours.timeZone,
  } } : {}) }
}

/** Device-local [start,end), wrapping midnight. Equal endpoints mean all day; DST follows IANA. */
export function inQuietHours(preferences?: NotificationPreferences, now = Date.now()): boolean {
  const q = preferences?.quietHours
  if (!q?.enabled) return false
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: q.timeZone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }).formatToParts(now)
    const minutes = Number(parts.find(part => part.type === 'hour')?.value) * 60 + Number(parts.find(part => part.type === 'minute')?.value)
    if (!Number.isFinite(minutes)) return false
    if (q.startMinutes === q.endMinutes) return true
    return q.startMinutes < q.endMinutes ? minutes >= q.startMinutes && minutes < q.endMinutes :
      minutes >= q.startMinutes || minutes < q.endMinutes
  } catch { return false }
}
