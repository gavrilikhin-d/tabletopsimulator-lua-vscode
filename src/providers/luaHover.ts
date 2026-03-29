/**
 * @file Lua Hover Provider
 * This provider is used to provide hovers for lua files. It's currently only used to hightlight
 * objects in the game when hovering over their GUID.
 */

import * as fs from 'fs'
import * as vscode from 'vscode'
import TTSService from '@/TTSService'
import getExtensionUri from '@/utils/getExtensionUri'
import isGuidValid from '@/utils/isGuidValid'
import * as apiManager from './luaCompletion/apiManager'
import {
  collectTrackedSignaturesFromSource,
  collectRequiredTrackedSignatures,
  normalizeDocType,
  type TrackedSignature
} from './luaSignatureHelp'

const luaScript = fs
  .readFileSync(
    vscode.Uri.joinPath(getExtensionUri(), 'assets', 'lua', 'highlightVsCode.lua').fsPath,
    'utf-8'
  )
  .toString()

export default class LuaHoverProvider implements vscode.HoverProvider {
  private api: apiManager.LuaAPI | undefined

  private buildLuaSignatureCodeBlock(
    name: string,
    parameters: Array<{ name: string }>,
    returnType?: string
  ): string {
    const paramsLabel = parameters.map((parameter) => parameter.name).join(', ')
    const returnSuffix = returnType !== undefined ? ` -> ${normalizeDocType(returnType)}` : ''
    return ['```lua', `function ${name}(${paramsLabel})${returnSuffix}`, '```', ''].join('\n')
  }

  async preload(): Promise<void> {
    this.api = await apiManager.loadApi()
  }

  private buildTrackedHover(signature: TrackedSignature): vscode.MarkdownString {
    const markdown = new vscode.MarkdownString()
    markdown.appendMarkdown(
      this.buildLuaSignatureCodeBlock(
        signature.name,
        signature.parameters,
        normalizeDocType(signature.returnType)
      )
    )

    if (signature.description !== undefined) markdown.appendMarkdown(`${signature.description}\n\n`)
    if (signature.parameters.length > 0) {
      markdown.appendMarkdown('**Parameters**\n')
      for (const parameter of signature.parameters) {
        const typeText =
          normalizeDocType(parameter.type) !== undefined
            ? ` \`{${normalizeDocType(parameter.type)}}\``
            : ''
        const description = parameter.description !== undefined ? ` - ${parameter.description}` : ''
        markdown.appendMarkdown(`- **${parameter.name}**${typeText}${description}\n`)
      }
      markdown.appendMarkdown('\n')
    }
    if (signature.returnType !== undefined || signature.returnDescription !== undefined) {
      markdown.appendMarkdown(
        `**Returns** \`${normalizeDocType(signature.returnType) ?? 'unknown'}\`${
          signature.returnDescription !== undefined ? ` - ${signature.returnDescription}` : ''
        }\n`
      )
    }
    return markdown
  }

  private buildApiHover(member: apiManager.Member): vscode.MarkdownString {
    const markdown = new vscode.MarkdownString()
    const params = member.parameters ?? []
    markdown.appendMarkdown(
      this.buildLuaSignatureCodeBlock(
        member.name,
        params.map((parameter) => ({ name: parameter.name })),
        member.type !== '' ? member.type : undefined
      )
    )
    markdown.appendMarkdown(`${member.description}\n\n`)
    if (params.length > 0) {
      markdown.appendMarkdown('**Parameters**\n')
      for (const parameter of params) {
        markdown.appendMarkdown(
          `- **${parameter.name}** \`${parameter.type}\`${parameter.description !== undefined ? ` - ${parameter.description}` : ''}\n`
        )
      }
      markdown.appendMarkdown('\n')
    }
    if (member.return_table !== undefined && member.return_table.length > 0) {
      markdown.appendMarkdown('**Returns**\n')
      for (const returnField of member.return_table) {
        markdown.appendMarkdown(
          `- \`${returnField.type}\`${returnField.description !== undefined ? ` - ${returnField.description}` : ''}\n`
        )
      }
    }
    return markdown
  }

  async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position
  ): Promise<vscode.Hover | null> {
    // Get hovered text
    const range = document.getWordRangeAtPosition(position)
    if (range === undefined) return null
    const hoveredText = document.getText(range)
    // check if hovered text is GUID format
    if (isGuidValid(hoveredText)) {
      await TTSService.getApi().executeLuaCode(luaScript.replace('{{guid}}', hoveredText), '-1')
      return new vscode.Hover('Highlighting object in game...')
    }

    const tracked = collectTrackedSignaturesFromSource(document.getText(), true)
    const required = await collectRequiredTrackedSignatures(document.getText())
    for (const [name, signatures] of required.entries()) {
      tracked.set(name, (tracked.get(name) ?? []).concat(signatures))
    }
    const trackedSignature = tracked.get(hoveredText)?.[0]
    if (trackedSignature !== undefined) {
      return new vscode.Hover(this.buildTrackedHover(trackedSignature))
    }

    const apiMembers = Object.values(this.api?.sections ?? {})
      .flat()
      .filter(
        (member) => member.name === hoveredText || member.name.split(/[.:]/).at(-1) === hoveredText
      )
    if (apiMembers.length > 0) return new vscode.Hover(this.buildApiHover(apiMembers[0]))

    return null
  }
}
