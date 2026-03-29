import {
  type SignatureHelpProvider,
  type TextDocument,
  type Position,
  type CancellationToken,
  SignatureHelp,
  SignatureInformation,
  ParameterInformation,
  MarkdownString,
  workspace
} from 'vscode'
import type { LuaAPI, Member } from './luaCompletion/apiManager'
import * as apiManager from './luaCompletion/apiManager'
import { locateModule } from '@/utils/moduleResolution'
import { logger } from '@/vscode/logger'

interface TrackedParameter {
  name: string
  type?: string
  description?: string
}

export interface TrackedSignature {
  name: string
  parameters: TrackedParameter[]
  returnType?: string
  returnDescription?: string
  description?: string
  isDeprecated?: boolean
}

function isLikelyTtsEventName(name: string): boolean {
  const shortName = name.split(/[.:]/).at(-1) ?? name
  return /^on[A-Z_]/u.test(shortName)
}

function getOfficialApiMember(api: LuaAPI | undefined, name: string): Member | undefined {
  for (const members of Object.values(api?.sections ?? {})) {
    for (const member of members as Member[]) {
      const shortName = member.name.split(/[.:]/).at(-1) ?? member.name
      if (member.name === name || shortName === name) return member
    }
  }
  return undefined
}

function buildLuaSignatureCodeBlock(
  name: string,
  parameters: TrackedParameter[],
  returnType?: string
): string {
  const paramsLabel = parameters.map((parameter) => parameter.name).join(', ')
  const returnSuffix = returnType !== undefined ? ` -> ${normalizeDocType(returnType)}` : ''
  return ['```lua', `function ${name}(${paramsLabel})${returnSuffix}`, '```', ''].join('\n')
}

interface DefinitionPattern {
  regex: RegExp
  isLocalDefinition: boolean
}

function getDefinitionPatterns(): DefinitionPattern[] {
  return [
    {
      regex: /^\s*local\s+function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)/,
      isLocalDefinition: true
    },
    {
      regex: /^\s*function\s+([A-Za-z_][A-Za-z0-9_]*(?:[.:][A-Za-z_][A-Za-z0-9_]*)*)\s*\(([^)]*)\)/,
      isLocalDefinition: false
    },
    {
      regex: /^\s*local\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*function\s*\(([^)]*)\)/,
      isLocalDefinition: true
    },
    {
      regex:
        /^\s*([A-Za-z_][A-Za-z0-9_]*(?:[.:][A-Za-z_][A-Za-z0-9_]*)*)\s*=\s*function\s*\(([^)]*)\)/,
      isLocalDefinition: false
    }
  ]
}

function parseFunctionParameters(paramsRaw: string): string[] {
  if (paramsRaw.trim() === '') return []
  return paramsRaw
    .split(',')
    .map((param) => param.trim())
    .filter((param) => param.length > 0)
}

export function normalizeDocType(type: string | undefined): string | undefined {
  if (type === undefined) return undefined
  const normalized = type.trim().replace(/^\{/, '').replace(/\}$/, '').trim()
  return normalized === '' ? undefined : normalized
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

function getDocCommentMetadata(
  lines: string[],
  definitionLineIndex: number,
  fallbackParameterNames: string[]
): TrackedSignature {
  const docLines: string[] = []
  for (let index = definitionLineIndex - 1; index >= 0; index--) {
    const trimmedLine = lines[index].trim()
    if (trimmedLine.startsWith('---')) {
      docLines.unshift(trimmedLine.replace(/^---\s?/, ''))
      continue
    }
    if (trimmedLine === '') continue
    break
  }

  const signature: TrackedSignature = {
    name: '',
    parameters: fallbackParameterNames.map((name) => ({ name }))
  }
  const descriptions: string[] = []
  const paramsByName = new Map(signature.parameters.map((parameter) => [parameter.name, parameter]))

  for (const docLine of docLines) {
    if (docLine.startsWith('@param')) {
      const jsStyleMatch = docLine.match(
        /^@param\s+\{([^}]+)\}\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:-\s*(.+))?$/u
      )
      const emmyStyleMatch = docLine.match(/^@param\s+([A-Za-z_][A-Za-z0-9_]*)\s+([^\s]+)\s*(.*)$/u)
      const paramName = jsStyleMatch?.[2] ?? emmyStyleMatch?.[1]
      if (paramName === undefined) continue
      const parameter = paramsByName.get(paramName) ?? { name: paramName }
      parameter.type = normalizeDocType(jsStyleMatch?.[1] ?? emmyStyleMatch?.[2]) ?? parameter.type
      parameter.description = jsStyleMatch?.[3] ?? emmyStyleMatch?.[3] ?? parameter.description
      if (!paramsByName.has(paramName)) {
        signature.parameters.push(parameter)
        paramsByName.set(paramName, parameter)
      }
      continue
    }

    if (docLine.startsWith('@returns') || docLine.startsWith('@return')) {
      const jsStyleMatch = docLine.match(/^@returns?\s+\{([^}]+)\}\s*(?:-\s*(.+))?$/u)
      const emmyStyleMatch = docLine.match(/^@returns?\s+([^\s]+)\s*(.*)$/u)
      signature.returnType =
        normalizeDocType(jsStyleMatch?.[1] ?? emmyStyleMatch?.[1]) ?? signature.returnType
      signature.returnDescription =
        jsStyleMatch?.[2] ?? emmyStyleMatch?.[2] ?? signature.returnDescription
      continue
    }

    if (docLine.startsWith('@deprecated')) {
      signature.isDeprecated = true
      const deprecatedDescription = docLine.replace(/^@deprecated\s*/u, '').replace(/^-+\s*/u, '')
      if (deprecatedDescription !== '') descriptions.push(`Deprecated: ${deprecatedDescription}`)
      continue
    }

    if (!docLine.startsWith('@')) descriptions.push(docLine)
  }

  const description = descriptions.join('\n').trim()
  signature.description = description === '' ? undefined : description
  return signature
}

export function collectTrackedSignaturesFromSource(
  source: string,
  includeLocalDefinitions: boolean
): Map<string, TrackedSignature[]> {
  const signatures = new Map<string, TrackedSignature[]>()
  const lines = source.split(/\r?\n/)
  const patterns = getDefinitionPatterns()

  const addSignature = (name: string, signature: TrackedSignature): void => {
    const existing = signatures.get(name) ?? []
    existing.push(signature)
    signatures.set(name, existing)
  }

  lines.forEach((line, lineIndex) => {
    for (const pattern of patterns) {
      if (!includeLocalDefinitions && pattern.isLocalDefinition) continue
      const match = line.match(pattern.regex)
      const fullName = match?.[1]
      if (fullName === undefined) continue
      const parsedParameters = parseFunctionParameters(match?.[2] ?? '')
      const metadata = getDocCommentMetadata(lines, lineIndex, parsedParameters)
      const signature: TrackedSignature = {
        ...metadata,
        name: fullName,
        parameters:
          metadata.parameters.length > 0
            ? metadata.parameters
            : parsedParameters.map((name) => ({ name }))
      }
      addSignature(fullName, signature)
      const tailName = fullName.split(/[.:]/).at(-1)
      if (tailName !== undefined && tailName !== fullName) addSignature(tailName, signature)
    }
  })

  return signatures
}

export async function collectRequiredTrackedSignatures(
  source: string,
  depth = 0,
  visited = new Set<string>()
): Promise<Map<string, TrackedSignature[]>> {
  const collected = new Map<string, TrackedSignature[]>()
  if (depth > 2) return collected

  for (const moduleName of getRequiredModuleNames(source)) {
    try {
      const moduleUri = await locateModule(moduleName)
      if (visited.has(moduleUri.fsPath)) continue
      visited.add(moduleUri.fsPath)

      const moduleSource = new TextDecoder().decode(await workspace.fs.readFile(moduleUri))
      const moduleSignatures = collectTrackedSignaturesFromSource(moduleSource, true)
      for (const [name, signatures] of moduleSignatures.entries()) {
        collected.set(name, (collected.get(name) ?? []).concat(signatures))
      }
      const nested = await collectRequiredTrackedSignatures(moduleSource, depth + 1, visited)
      for (const [name, signatures] of nested.entries()) {
        collected.set(name, (collected.get(name) ?? []).concat(signatures))
      }
    } catch (error) {
      logger.debug(`Failed to collect required signatures for "${moduleName}"`, error)
    }
  }

  return collected
}

function findCallContext(
  textBeforeCursor: string
): { name: string; activeParameter: number } | null {
  let depth = 0
  let activeParameter = 0

  for (let index = textBeforeCursor.length - 1; index >= 0; index--) {
    const character = textBeforeCursor[index]
    if (character === ')') {
      depth++
      continue
    }
    if (character === '(') {
      if (depth === 0) {
        const beforeParen = textBeforeCursor.slice(0, index).trimEnd()
        const nameMatch = beforeParen.match(
          /([A-Za-z_][A-Za-z0-9_]*(?:[.:][A-Za-z_][A-Za-z0-9_]*)*)$/u
        )
        if (nameMatch === null) return null
        return { name: nameMatch[1], activeParameter }
      }
      depth--
      continue
    }
    if (character === ',' && depth === 0) activeParameter++
  }

  return null
}

function buildTrackedSignatureInformation(
  signature: TrackedSignature,
  officialMember?: Member
): SignatureInformation {
  const shortName = signature.name.split(/[.:]/).at(-1) ?? signature.name
  const paramsLabel = signature.parameters
    .map((parameter) =>
      normalizeDocType(parameter.type) !== undefined
        ? `${parameter.name}: ${normalizeDocType(parameter.type)}`
        : parameter.name
    )
    .join(', ')
  const labelCore = `${shortName}(${paramsLabel})`
  const label =
    signature.returnType !== undefined
      ? `${labelCore} -> ${normalizeDocType(signature.returnType)}`
      : labelCore
  const doc = new MarkdownString()
  const hasLocalDescription = signature.description !== undefined
  const hasLocalParameters = signature.parameters.some(
    (parameter) => parameter.type !== undefined || parameter.description !== undefined
  )
  const hasLocalReturns =
    signature.returnType !== undefined || signature.returnDescription !== undefined
  const hasAnyLocalDocumentation = hasLocalDescription || hasLocalParameters || hasLocalReturns
  if (officialMember?.kind === 'event' || isLikelyTtsEventName(signature.name)) {
    doc.appendMarkdown('**TTS Event**\n\n')
  }
  doc.appendMarkdown(
    buildLuaSignatureCodeBlock(
      shortName,
      signature.parameters,
      normalizeDocType(signature.returnType)
    )
  )
  if (signature.isDeprecated === true) doc.appendMarkdown('**Deprecated**\n\n')
  if (hasLocalDescription) {
    doc.appendMarkdown(`**Description**\n${signature.description}\n\n`)
  }
  if (hasLocalParameters) {
    doc.appendMarkdown('**Parameters**\n')
    for (const parameter of signature.parameters) {
      const normalizedType = normalizeDocType(parameter.type)
      const typeText = normalizedType !== undefined ? ` \`{${normalizedType}}\`` : ''
      const descriptionText =
        parameter.description !== undefined && parameter.description !== ''
          ? ` - ${parameter.description}`
          : ''
      doc.appendMarkdown(`- **${parameter.name}**${typeText}${descriptionText}\n`)
    }
    doc.appendMarkdown('\n')
  }
  if (signature.returnDescription !== undefined) {
    doc.appendMarkdown(
      `**Returns** \`${normalizeDocType(signature.returnType) ?? 'unknown'}\` - ${signature.returnDescription}\n\n`
    )
  } else if (signature.returnType !== undefined) {
    doc.appendMarkdown(`**Returns** \`${normalizeDocType(signature.returnType)}\`\n\n`)
  }
  if (officialMember !== undefined) {
    if (hasAnyLocalDocumentation) doc.appendMarkdown('\n')
    doc.appendMarkdown(`${officialMember.description}\n\n`)
    if ((officialMember.parameters?.length ?? 0) > 0) {
      doc.appendMarkdown('**Parameters**\n')
      for (const parameter of officialMember.parameters ?? []) {
        const description = parameter.description !== undefined ? ` - ${parameter.description}` : ''
        doc.appendMarkdown(`- **${parameter.name}** \`${parameter.type}\`${description}\n`)
      }
      doc.appendMarkdown('\n')
    }
    if ((officialMember.return_table?.length ?? 0) > 0) {
      doc.appendMarkdown('**Returns**\n')
      for (const returnField of officialMember.return_table ?? []) {
        const description =
          returnField.description !== undefined ? ` - ${returnField.description}` : ''
        doc.appendMarkdown(`- \`${returnField.type}\`${description}\n`)
      }
      doc.appendMarkdown('\n')
    } else if (officialMember.type !== '') {
      doc.appendMarkdown(`**Returns** \`${officialMember.type}\`\n\n`)
    }
    doc.appendMarkdown(`[Official Documentation](${officialMember.url})\n\n`)
  }

  const info = new SignatureInformation(label, doc)
  info.parameters = signature.parameters.map((parameter) => {
    const parameterDoc = new MarkdownString()
    if (parameter.type !== undefined) {
      parameterDoc.appendMarkdown(`Type: \`${normalizeDocType(parameter.type)}\`\n\n`)
    }
    if (parameter.description !== undefined) parameterDoc.appendMarkdown(parameter.description)
    return new ParameterInformation(
      normalizeDocType(parameter.type) !== undefined
        ? `${parameter.name}: ${normalizeDocType(parameter.type)}`
        : parameter.name,
      parameterDoc
    )
  })
  return info
}

function buildApiSignatureInformation(member: Member): SignatureInformation {
  const parameters = member.parameters ?? []
  const paramsLabel = parameters
    .map((parameter) => `${parameter.name}: ${parameter.type}`)
    .join(', ')
  const returnType = member.return_table?.map((item) => item.type).join(', ') ?? member.type
  const label = `${member.name}(${paramsLabel})${returnType !== '' ? ` -> ${returnType}` : ''}`
  const doc = new MarkdownString()
  if (member.kind === 'event') doc.appendMarkdown('**TTS Event**\n\n')
  doc.appendMarkdown(
    buildLuaSignatureCodeBlock(
      member.name,
      parameters.map((parameter) => ({ name: parameter.name })),
      returnType !== '' ? returnType : undefined
    )
  )
  doc.appendMarkdown(member.description)

  const info = new SignatureInformation(label, doc)
  info.parameters = parameters.map((parameter) => {
    const parameterDoc = new MarkdownString()
    if (parameter.type !== undefined) parameterDoc.appendMarkdown(`Type: \`${parameter.type}\`\n\n`)
    if (parameter.description !== undefined) parameterDoc.appendMarkdown(parameter.description)
    return new ParameterInformation(`${parameter.name}: ${parameter.type}`, parameterDoc)
  })
  return info
}

export default class LuaSignatureHelpProvider implements SignatureHelpProvider {
  private api: LuaAPI | undefined
  private readonly apiSignatures = new Map<string, SignatureInformation[]>()

  public async preload(): Promise<void> {
    this.api = await apiManager.loadApi()
    this.apiSignatures.clear()
    for (const members of Object.values(this.api.sections)) {
      for (const member of members) {
        if (member.kind !== 'function' && member.kind !== 'event') continue
        const info = buildApiSignatureInformation(member)
        const fullName = member.name
        const shortName = member.name.split(/[.:]/).at(-1) ?? member.name
        this.apiSignatures.set(fullName, (this.apiSignatures.get(fullName) ?? []).concat(info))
        this.apiSignatures.set(shortName, (this.apiSignatures.get(shortName) ?? []).concat(info))
      }
    }
  }

  public async provideSignatureHelp(
    document: TextDocument,
    position: Position,
    token: CancellationToken
  ): Promise<SignatureHelp | null> {
    if (token.isCancellationRequested) return null
    const textBeforeCursor = document.lineAt(position.line).text.substring(0, position.character)
    const context = findCallContext(textBeforeCursor)
    if (context === null) return null

    const tracked = collectTrackedSignaturesFromSource(document.getText(), true)
    const required = await collectRequiredTrackedSignatures(document.getText())
    for (const [name, signatures] of required.entries()) {
      tracked.set(name, (tracked.get(name) ?? []).concat(signatures))
    }

    const trackedInfos = (tracked.get(context.name) ?? []).map((signature) =>
      buildTrackedSignatureInformation(signature, getOfficialApiMember(this.api, context.name))
    )
    const apiInfos = this.apiSignatures.get(context.name) ?? []
    const signatures = [...trackedInfos, ...apiInfos]
    if (signatures.length === 0) return null

    const help = new SignatureHelp()
    help.signatures = signatures
    help.activeSignature = 0
    help.activeParameter = Math.min(
      context.activeParameter,
      Math.max(0, signatures[0].parameters.length - 1)
    )
    return help
  }
}
