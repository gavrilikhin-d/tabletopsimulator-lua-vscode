import { type ObjectCreated } from '@matanlurey/tts-editor'
import { logger } from '@/vscode/logger'

export default (e: ObjectCreated): void => {
  logger.info('Object created:', e)
}
