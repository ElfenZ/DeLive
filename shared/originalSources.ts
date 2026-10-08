export interface OriginalSourceInfo { id: string; revision: number; fileName: string; size: number; sha256: string }
export interface OriginalRenamePreview {
  token: string; sourceId: string; sourceRevision: number; sessionId: string; titleRevision: number
  oldName: string; newName: string; directory: string; affectedSessionIds: string[]; expiresAt: number
}
export interface OriginalSourceResult { ok: boolean; source?: OriginalSourceInfo; preview?: OriginalRenamePreview; error?: string }
