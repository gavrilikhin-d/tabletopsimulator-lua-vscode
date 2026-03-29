/**
 * @file Lua Definition Provider
 * This provider resolves Lua definitions by:
 * 1) Resolving `require("module")` targets using moduleResolution lookup.
 * 2) Tracking function/variable definitions in the current document.
 */

import {
  type DefinitionProvider,
  type TextDocument,
  type Position,
  type CancellationToken,
  Location,
  type Definition,
  Range
} from 'vscode'
import { locateModule } from '@/utils/moduleResolution'
import { logger } from '@/vscode/logger'

export class LuaDefinitionProvider implements DefinitionProvider {
  public async provideDefinition(
    document: TextDocument,
    position: Position,
    token: CancellationToken
  ): Promise<Definition | null> {
    if (token.isCancellationRequested) return null

    const line = document.lineAt(position.line).text
    const moduleName = this.getRequireModuleAtPosition(line, position.character)
    if (moduleName !== undefined) {
      try {
        const uri = await locateModule(moduleName)
        return new Location(uri, new Range(0, 0, 0, 0))
      } catch {
        logger.debug(`Module not found for definition lookup: ${moduleName}`)
      }
    }

    const wordRange = document.getWordRangeAtPosition(position, /\b[A-Za-z_][A-Za-z0-9_]*\b/)
    if (wordRange === undefined) return null
    const symbolName = document.getText(wordRange)
    const trackedDefinitions = this.trackDefinitions(document)
    const candidates = trackedDefinitions.get(symbolName) ?? []
    if (candidates.length === 0) return null

    const closestPrevious = [...candidates]
      .filter((location) => location.range.start.line <= position.line)
      .sort((a, b) => b.range.start.line - a.range.start.line)[0]
    return closestPrevious ?? candidates[0]
  }

  private getRequireModuleAtPosition(line: string, character: number): string | undefined {
    const requireRegex = /require\s*\(\s*["']([^"']+)["']\s*\)/g
    for (const match of line.matchAll(requireRegex)) {
      const fullMatch = match[0]
      const moduleName = match[1]
      if (fullMatch === undefined || moduleName === undefined) continue
      const start = match.index ?? -1
      if (start === -1) continue
      const end = start + fullMatch.length
      if (character >= start && character <= end) return moduleName
    }
    return undefined
  }

  private trackDefinitions(document: TextDocument): Map<string, Location[]> {
    const definitions = new Map<string, Location[]>()
    const lines = document.getText().split(/\r?\n/)
    const patterns = [
      /^\s*local\s+function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/,
      /^\s*function\s+([A-Za-z_][A-Za-z0-9_]*(?:[.:][A-Za-z_][A-Za-z0-9_]*)*)\s*\(/,
      /^\s*local\s+([A-Za-z_][A-Za-z0-9_]*)\s*=/,
      /^\s*([A-Za-z_][A-Za-z0-9_]*(?:[.:][A-Za-z_][A-Za-z0-9_]*)*)\s*=\s*function\s*\(/
    ]

    const addDefinition = (name: string, lineIndex: number, charIndex: number): void => {
      const location = new Location(
        document.uri,
        new Range(lineIndex, charIndex, lineIndex, charIndex + name.length)
      )
      const existing = definitions.get(name) ?? []
      existing.push(location)
      definitions.set(name, existing)
    }

    lines.forEach((line, lineIndex) => {
      for (const regex of patterns) {
        const match = line.match(regex)
        const fullName = match?.[1]
        if (fullName === undefined) continue
        const fullNameIndex = line.indexOf(fullName)
        if (fullNameIndex !== -1) addDefinition(fullName, lineIndex, fullNameIndex)

        const tailName = fullName.split(/[.:]/).at(-1)
        if (tailName !== undefined && tailName !== fullName) {
          const tailNameIndex = line.indexOf(tailName, fullNameIndex)
          if (tailNameIndex !== -1) addDefinition(tailName, lineIndex, tailNameIndex)
        }
      }
    })

    return definitions
  }
}
