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
  workspace,
  type Definition,
  Range
} from 'vscode'
import { locateModule } from '@/utils/moduleResolution'
import { logger } from '@/vscode/logger'

interface DefinitionPattern {
  regex: RegExp
  isLocalDefinition: boolean
}

function getDefinitionPatterns(): DefinitionPattern[] {
  return [
    { regex: /^\s*local\s+function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/, isLocalDefinition: true },
    {
      regex: /^\s*function\s+([A-Za-z_][A-Za-z0-9_]*(?:[.:][A-Za-z_][A-Za-z0-9_]*)*)\s*\(/,
      isLocalDefinition: false
    },
    { regex: /^\s*local\s+([A-Za-z_][A-Za-z0-9_]*)\s*=/, isLocalDefinition: true },
    {
      regex: /^\s*([A-Za-z_][A-Za-z0-9_]*(?:[.:][A-Za-z_][A-Za-z0-9_]*)*)\s*=\s*function\s*\(/,
      isLocalDefinition: false
    },
    {
      regex: /^\s*([A-Za-z_][A-Za-z0-9_]*(?:[.:][A-Za-z_][A-Za-z0-9_]*)*)\s*=/,
      isLocalDefinition: false
    }
  ]
}

function getRequiredModuleNames(source: string): string[] {
  const modules = new Set<string>()
  const requireRegex = /require\s*\(\s*["']([^"']+)["']\s*\)/g
  for (const match of source.matchAll(requireRegex)) {
    const moduleName = match[1]?.trim()
    if (moduleName !== undefined && moduleName !== '') modules.add(moduleName)
  }
  return [...modules]
}

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
    const source = document.getText()
    const trackedDefinitions = this.trackDefinitionsInSource(source, document.uri, true)
    const requiredDefinitions = await this.trackRequiredModuleDefinitions(source)
    this.mergeDefinitions(trackedDefinitions, requiredDefinitions)
    const candidates = trackedDefinitions.get(symbolName) ?? []
    if (candidates.length === 0) return null

    const inCurrentFile = candidates.filter(
      (location) => location.uri.fsPath === document.uri.fsPath
    )
    const closestPrevious = [...inCurrentFile]
      .filter((location) => location.range.start.line < position.line)
      .sort((a, b) => b.range.start.line - a.range.start.line)[0]
    return closestPrevious ?? inCurrentFile[0] ?? candidates[0]
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

  private trackDefinitionsInSource(
    source: string,
    uri: TextDocument['uri'],
    includeLocalDefinitions: boolean
  ): Map<string, Location[]> {
    const definitions = new Map<string, Location[]>()
    const lines = source.split(/\r?\n/)
    const patterns = getDefinitionPatterns()

    const addDefinition = (name: string, lineIndex: number, charIndex: number): void => {
      const location = new Location(
        uri,
        new Range(lineIndex, charIndex, lineIndex, charIndex + name.length)
      )
      const existing = definitions.get(name) ?? []
      existing.push(location)
      definitions.set(name, existing)
    }

    lines.forEach((line, lineIndex) => {
      for (const pattern of patterns) {
        if (!includeLocalDefinitions && pattern.isLocalDefinition) continue
        const match = line.match(pattern.regex)
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

  private mergeDefinitions(
    target: Map<string, Location[]>,
    source: Map<string, Location[]>
  ): Map<string, Location[]> {
    for (const [symbol, locations] of source.entries()) {
      const existing = target.get(symbol) ?? []
      target.set(symbol, existing.concat(locations))
    }
    return target
  }

  private async trackRequiredModuleDefinitions(
    source: string,
    depth = 0,
    visited = new Set<string>()
  ): Promise<Map<string, Location[]>> {
    const result = new Map<string, Location[]>()
    if (depth > 2) return result

    for (const moduleName of getRequiredModuleNames(source)) {
      try {
        const moduleUri = await locateModule(moduleName)
        if (visited.has(moduleUri.fsPath)) continue
        visited.add(moduleUri.fsPath)

        const moduleSource = new TextDecoder().decode(await workspace.fs.readFile(moduleUri))
        const moduleDefinitions = this.trackDefinitionsInSource(moduleSource, moduleUri, true)
        this.mergeDefinitions(result, moduleDefinitions)

        const nestedDefinitions = await this.trackRequiredModuleDefinitions(
          moduleSource,
          depth + 1,
          visited
        )
        this.mergeDefinitions(result, nestedDefinitions)
      } catch (error) {
        logger.debug(`Module not found while tracking definitions: ${moduleName}`, error)
      }
    }
    return result
  }
}
