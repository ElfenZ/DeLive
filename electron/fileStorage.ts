import { app } from 'electron'
import { FileStorageService } from './fileStorageService'

let service: FileStorageService | undefined

export function getFileStorageService(): FileStorageService {
  if (!service) service = new FileStorageService(app.getPath('userData'))
  return service
}
