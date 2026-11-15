/** Optional read-only resource vocabulary, mirrored by the native clients. */
export type RemoteFileRef =
  | { kind: 'deliverable'; sourceSeq: number; fileIndex: number }
  | { kind: 'workspace'; rootRef: string; path: string }
export interface DeliveredFile { index: number; name: string; description?: string }
export interface ChangedFile { index: number; path: string; added: number; deleted: number; binary?: boolean; oversized?: boolean }
export interface SessionResource {
  kind: 'deliverables' | 'changes'
  sourceSeq: number
  turn: number
  anchorSeq: number
  files?: DeliveredFile[]
  changes?: ChangedFile[]
  total?: number
  added?: number
  deleted?: number
  available?: boolean
  truncated?: boolean
}
export interface SessionResourcesPage { sessionId: string; items: SessionResource[]; hasMore: boolean; nextBeforeSeq?: number }
export interface RemoteFileInfo { sessionId: string; name: string; version: string; bytes?: number; mediaType: string }
export interface RemoteTextPage extends RemoteFileInfo { offset: number; text: string; lines: number; eof: boolean }
export interface RemoteDirectoryEntry { name: string; path: string; kind: 'file' | 'directory'; bytes?: number }
export interface RemoteDirectory { sessionId: string; rootRef: string; rootLabel: string; path: string; entries: RemoteDirectoryEntry[]; truncated: boolean; incomplete?: boolean; query?: string }
export interface RemoteFileManifest extends RemoteFileInfo { transferId: string; bytes: number; sha256: string }
export interface RemoteDiffLine { kind: 'added' | 'removed' | 'context' | 'header'; text: string; old?: number; new?: number; truncated?: boolean }
export interface RemoteDiffPage { sessionId: string; sourceSeq: number; fileIndex: number; path: string; kind: 'text' | 'binary' | 'oversized' | 'expired'; lines: RemoteDiffLine[]; nextOffset?: number; coarse?: boolean }
