import { useSessionStore } from '../stores/sessionStore'
import { useFileTranscriptionStore } from '../stores/fileTranscriptionStore'

export function assertBackupRestoreIdle(): void {
  const sessions = useSessionStore.getState()
  if (sessions.currentSessionId || useFileTranscriptionStore.getState().getActiveJobs().length > 0
    || sessions.sessions.some((session) => session.correction?.draft?.status === 'running'
      || session.postProcess?.status === 'pending' || session.mindMap?.status === 'pending'
      || session.askHistory?.some((turn) => turn.status === 'pending')
      || session.autoPostProcessWorkflow?.status === 'running'
      || session.autoPostProcessWorkflow?.status === 'queued'
      || session.correctedMarkdownFile?.status === 'saving')) {
    throw new Error('Stop recording, file tasks and active AI/file work before restoring a backup')
  }
}
