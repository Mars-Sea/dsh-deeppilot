export interface PromptDocument {
  name: string
  mediaType: string
  text: string
  truncated?: boolean
}

interface DocumentMarker {
  v: 1
  name: string
  mediaType: string
  truncated?: boolean
}

const PREFIX = '[DeepPilot document:'
const SUFFIX = ']'

/**
 * DSH 0.1.2 has durable image attachments but no generic file content block.
 * Documents therefore travel as a bounded, explicitly-labelled text block.
 * The marker lets the canonical phone row recover an attachment chip without
 * exposing the complete document body as ordinary user-authored bubble text.
 */
export function documentPromptBlock(document: PromptDocument): string {
  const marker: DocumentMarker = {
    v: 1,
    name: document.name,
    mediaType: document.mediaType,
    ...(document.truncated ? { truncated: true } : {}),
  }
  const encoded = Buffer.from(JSON.stringify(marker), 'utf8').toString('base64url')
  return `${PREFIX}${encoded}${SUFFIX}\nAttached document: ${document.name}\n\n${document.text}`
}

export function projectedDocument(text: string): PromptDocument | undefined {
  if (!text.startsWith(PREFIX)) return undefined
  const end = text.indexOf(SUFFIX, PREFIX.length)
  if (end < 0) return undefined
  try {
    const decoded = JSON.parse(Buffer.from(text.slice(PREFIX.length, end), 'base64url').toString('utf8')) as Partial<DocumentMarker>
    if (decoded.v !== 1 || typeof decoded.name !== 'string' || typeof decoded.mediaType !== 'string') return undefined
    if (!decoded.name.trim() || !decoded.mediaType.trim()) return undefined
    return {
      name: decoded.name,
      mediaType: decoded.mediaType,
      text: text.slice(end + SUFFIX.length).replace(/^\nAttached document:[^\n]*\n\n/, ''),
      ...(decoded.truncated === true ? { truncated: true } : {}),
    }
  } catch {
    return undefined
  }
}
