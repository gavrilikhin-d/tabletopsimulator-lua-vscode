import { type CustomMessage } from '@matanlurey/tts-editor'
import { logger } from '@/vscode/logger'

export default (e: CustomMessage): void => {
  logger.info(e)
}
