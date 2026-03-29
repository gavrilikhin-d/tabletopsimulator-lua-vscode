/**
 * @file This file registers all providers for the extension.
 * Providers are used to provide features like completion, hover, etc.
 */

import { type Disposable, languages, extensions, window, commands } from 'vscode'
import { type HScopesAPI } from './hscopes'
// Completion Providers
import LuaCompletionProvider from './luaCompletion/provider'
import LuaSignatureHelpProvider from './luaSignatureHelp'
import LuaDocSemanticTokensProvider, { luaDocSemanticTokensLegend } from './luaDocSemanticTokens'
import XMLCompletionProvider from './xmlCompletion/provider'
// Definition Providers
import { LuaDefinitionProvider } from './luaDefinition'
// Hover Providers
import LuaHoverProvider from './luaHover'
import TTSElementTreeDataProvider from './elementTreeData'

// Expose a map of virtual documents to the rest of the providers
export const virtualDocumentContents = new Map<string, string>()
export let hs: HScopesAPI
export const triggers: Record<string, string[]> = {
  lua: ['.', ':', '(', ')', ' ', '-'],
  xml: ['<', '/', ' ']
}

export interface LineToken {
  value: string
  start: number
  end: number
  scopes: string[]
}

const [
  luaCompletionProvider,
  luaSignatureHelpProvider,
  luaDocSemanticTokensProvider,
  xmlCompletionProvider,
  luaHoverProvider,
  luaDefinitionProvider,
  ttsElementTreeDataProvider
] = [
  new LuaCompletionProvider(),
  new LuaSignatureHelpProvider(),
  new LuaDocSemanticTokensProvider(),
  new XMLCompletionProvider(),
  new LuaHoverProvider(),
  new LuaDefinitionProvider(),
  new TTSElementTreeDataProvider()
]

/**
 * Registers all providers for this extension
 * @returns An array of Disposables to be disposed when the extension is deactivated
 */
export default function registerProviders(): Disposable[] {
  // Activate the HyperScopes extension
  const hsExt = extensions.getExtension<HScopesAPI>('draivin.hscopes')
  if (hsExt === undefined) throw new Error('HyperScopes Extension not installed')
  // Expose the HyperScopes API to the rest of the providers
  void hsExt.activate().then((api) => {
    hs = api
  })
  void xmlCompletionProvider.preload()
  luaCompletionProvider.preload().catch((err: Error) => {
    // If it's a type error it's probably because the API changed
    if (err instanceof TypeError) {
      void window.showErrorMessage(
        'Failed to preload Lua API, please report this issue to the extension author. Autocompletion disabled'
      )
      throw Error(`Failed to preload Lua API: ${err.message}`)
    }
    throw err
  })
  void luaSignatureHelpProvider.preload()
  void luaHoverProvider.preload()
  commands.registerCommand('ttslua.refresh', () => {
    ttsElementTreeDataProvider.refresh()
  })
  return [
    languages.registerDefinitionProvider('lua', luaDefinitionProvider),
    languages.registerHoverProvider('lua', luaHoverProvider),
    languages.registerSignatureHelpProvider('lua', luaSignatureHelpProvider, '(', ','),
    languages.registerDocumentSemanticTokensProvider(
      'lua',
      luaDocSemanticTokensProvider,
      luaDocSemanticTokensLegend
    ),
    languages.registerCompletionItemProvider('xml', xmlCompletionProvider, ...triggers.xml),
    languages.registerCompletionItemProvider('lua', luaCompletionProvider, ...triggers.lua),
    window.registerTreeDataProvider('ttslua-explorer', ttsElementTreeDataProvider)
  ]
}
