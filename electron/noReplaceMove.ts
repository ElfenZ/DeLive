import path from 'path'
import { inspectRegularFile, sameFileIdentity, comparePath, assertSafeDirectory, type FileIdentity } from './fileStorageService'
import { protectedWindowsFileOperation } from './windowsFileHandle'

export async function noReplaceMove(source: string, target: string, expected: { identity: FileIdentity; sha256: string }): Promise<void> {
  if (comparePath(path.dirname(source)) !== comparePath(path.dirname(target))) throw new Error('Move must stay in its current directory')
  if (source === target) return
  await assertSafeDirectory(path.dirname(source))
  const current = await inspectRegularFile(source)
  if (!sameFileIdentity(current.identity, expected.identity) || current.sha256 !== expected.sha256) throw new Error('File was modified or replaced; preview again')
  await protectedWindowsFileOperation({ action: 'move', source, target, ...expected })
  const moved = await inspectRegularFile(target)
  if (moved.identity.dev !== expected.identity.dev || moved.identity.ino !== expected.identity.ino || moved.identity.size !== expected.identity.size || moved.sha256 !== expected.sha256) throw new Error('Moved file identity changed; reconciliation required')
}
