import {
  type SemanticTokens,
  SemanticTokensBuilder,
  SemanticTokensLegend,
  type DocumentSemanticTokensProvider,
  type TextDocument,
  type CancellationToken
} from 'vscode'

const tokenTypes = ['type', 'parameter', 'keyword']
export const luaDocSemanticTokensLegend = new SemanticTokensLegend(tokenTypes)
const builtinDocTypes = new Set([
  'nil',
  'int',
  'float',
  'bool',
  'string',
  'table',
  'vector',
  'color',
  'func',
  'function',
  'object',
  'player',
  'var'
])

function pushCaptureToken(
  builder: SemanticTokensBuilder,
  lineIndex: number,
  fullMatch: string,
  capture: string,
  matchIndex: number,
  tokenType: 'type' | 'parameter'
): void {
  const startInMatch = fullMatch.indexOf(capture)
  if (startInMatch === -1) return
  const char = matchIndex + startInMatch
  builder.push(lineIndex, char, capture.length, tokenTypes.indexOf(tokenType), 0)
}

function pushBuiltinTypeTokens(
  builder: SemanticTokensBuilder,
  lineIndex: number,
  fullMatch: string,
  typeExpression: string,
  matchIndex: number
): void {
  const typeExpressionOffset = fullMatch.indexOf(typeExpression)
  if (typeExpressionOffset === -1) return

  for (const typeMatch of typeExpression.matchAll(/[A-Za-z_][A-Za-z0-9_]*/gu)) {
    const typeName = typeMatch[0]
    const localIndex = typeMatch.index ?? -1
    if (localIndex === -1 || !builtinDocTypes.has(typeName.toLowerCase())) continue
    builder.push(
      lineIndex,
      matchIndex + typeExpressionOffset + localIndex,
      typeName.length,
      tokenTypes.indexOf('type'),
      0
    )
  }
}

function pushDocTagToken(
  builder: SemanticTokensBuilder,
  lineIndex: number,
  lineText: string
): void {
  const tagMatch = lineText.match(/^\s*---\s*(@[A-Za-z_][A-Za-z0-9_]*)/u)
  const tag = tagMatch?.[1]
  if (tag === undefined) return
  const char = lineText.indexOf(tag)
  if (char === -1) return
  builder.push(lineIndex, char, tag.length, tokenTypes.indexOf('keyword'), 0)
}

export default class LuaDocSemanticTokensProvider implements DocumentSemanticTokensProvider {
  provideDocumentSemanticTokens(document: TextDocument, _token: CancellationToken): SemanticTokens {
    const builder = new SemanticTokensBuilder(luaDocSemanticTokensLegend)
    const paramJsStyle = /@param\s+\{([^}]+)\}\s+([A-Za-z_][A-Za-z0-9_]*)/gu
    const returnsJsStyle = /@returns?\s+\{([^}]+)\}/gu

    for (let lineIndex = 0; lineIndex < document.lineCount; lineIndex++) {
      const lineText = document.lineAt(lineIndex).text
      if (!lineText.trimStart().startsWith('---')) continue
      pushDocTagToken(builder, lineIndex, lineText)

      for (const match of lineText.matchAll(paramJsStyle)) {
        const [fullMatch, typeName, paramName] = match
        const matchIndex = match.index ?? -1
        if (
          matchIndex === -1 ||
          fullMatch === undefined ||
          typeName === undefined ||
          paramName === undefined
        ) {
          continue
        }
        pushBuiltinTypeTokens(builder, lineIndex, fullMatch, typeName, matchIndex)
        pushCaptureToken(builder, lineIndex, fullMatch, paramName, matchIndex, 'parameter')
      }

      for (const match of lineText.matchAll(returnsJsStyle)) {
        const [fullMatch, typeName] = match
        const matchIndex = match.index ?? -1
        if (matchIndex === -1 || fullMatch === undefined || typeName === undefined) continue
        pushBuiltinTypeTokens(builder, lineIndex, fullMatch, typeName, matchIndex)
      }
    }

    return builder.build()
  }
}
