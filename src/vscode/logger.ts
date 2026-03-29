import { window, type ExtensionContext, type OutputChannel } from 'vscode'

let outputChannel: OutputChannel | undefined

function getOutputChannel(): OutputChannel {
  if (outputChannel === undefined) {
    outputChannel = window.createOutputChannel('TTS Lua')
  }
  return outputChannel
}

function toLogString(value: unknown): string {
  if (value instanceof Error) return value.stack ?? value.message
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function append(level: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG', values: unknown[]): void {
  const message = values.map(toLogString).join(' ')
  getOutputChannel().appendLine(`[${level}] ${message}`)
}

export const logger = {
  init(context: ExtensionContext): void {
    context.subscriptions.push(getOutputChannel())
  },
  info(...values: unknown[]): void {
    append('INFO', values)
  },
  warn(...values: unknown[]): void {
    append('WARN', values)
  },
  error(...values: unknown[]): void {
    append('ERROR', values)
  },
  debug(...values: unknown[]): void {
    append('DEBUG', values)
  }
}
