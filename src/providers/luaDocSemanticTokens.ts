import {
  type SemanticTokens,
  SemanticTokensBuilder,
  SemanticTokensLegend,
  type DocumentSemanticTokensProvider,
  type TextDocument,
  type CancellationToken
} from 'vscode'

const tokenTypes = ['type', 'parameter']
export const luaDocSemanticTokensLegend = new SemanticTokensLegend(tokenTypes)

function pushCaptureToken(
  builder: SemanticTokensBuilder,
  lineIndex: number,
  lineText: string,
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

export default class LuaDocSemanticTokensProvider implements DocumentSemanticTokensProvider {
  provideDocumentSemanticTokens(document: TextDocument, _token: CancellationToken): SemanticTokens {
    const builder = new SemanticTokensBuilder(luaDocSemanticTokensLegend)
    const paramJsStyle = /@param\s+\{([^}]+)\}\s+([A-Za-z_][A-Za-z0-9_]*)/gu
    const returnsJsStyle = /@returns?\s+\{([^}]+)\}/gu

    for (let lineIndex = 0; lineIndex < document.lineCount; lineIndex++) {
      const lineText = document.lineAt(lineIndex).text
      if (!lineText.trimStart().startsWith('---')) continue

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
        pushCaptureToken(builder, lineIndex, lineText, fullMatch, typeName, matchIndex, 'type')
        pushCaptureToken(
          builder,
          lineIndex,
          lineText,
          fullMatch,
          paramName,
          matchIndex,
          'parameter'
        )
      }

      for (const match of lineText.matchAll(returnsJsStyle)) {
        const [fullMatch, typeName] = match
        const matchIndex = match.index ?? -1
        if (matchIndex === -1 || fullMatch === undefined || typeName === undefined) continue
        pushCaptureToken(builder, lineIndex, lineText, fullMatch, typeName, matchIndex, 'type')
      }
    }

    return builder.build()
  }
}
