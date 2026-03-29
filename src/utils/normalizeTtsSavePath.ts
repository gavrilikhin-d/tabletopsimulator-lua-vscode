import { homedir, platform } from 'os'
import { join } from 'path'

const winDrivePrefix = /^[a-z]:\//i
const documentsMarker = '/documents/'

export default function normalizeTtsSavePath(inputPath: string): string {
  const trimmed = inputPath.trim()
  if (trimmed === '') return trimmed

  if (trimmed.startsWith('~')) {
    return join(homedir(), trimmed.slice(1))
  }

  const slashNormalized = trimmed.replace(/\\/g, '/').replace(/\/+/g, '/')
  const documentsIndex = slashNormalized.toLowerCase().indexOf(documentsMarker)

  // TTS running through CrossOver/Wine can report a Windows path.
  // On non-Windows hosts, map ".../Documents/..." to the local "~/Documents/...".
  if (platform() !== 'win32' && winDrivePrefix.test(slashNormalized) && documentsIndex !== -1) {
    const pathAfterDocuments = slashNormalized.slice(documentsIndex + documentsMarker.length)
    const pathParts = pathAfterDocuments.split('/').filter(Boolean)
    return join(homedir(), 'Documents', ...pathParts)
  }

  return inputPath
}
