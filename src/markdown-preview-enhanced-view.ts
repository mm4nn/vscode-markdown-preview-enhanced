import * as vscode from 'vscode'
import * as path from 'path'
import {Uri, CancellationToken, Event, ProviderResult, TextEditor} from 'vscode'

import * as mume from "@shd101wyy/mume"
import {MarkdownEngine} from "@shd101wyy/mume"

import {MarkdownPreviewEnhancedConfig} from "./config"

let singlePreviewSouceUri:Uri = null

// http://www.typescriptlang.org/play/
// https://github.com/Microsoft/vscode/blob/master/extensions/markdown/media/main.js
// https://github.com/Microsoft/vscode/tree/master/extensions/markdown/src
// https://github.com/tomoki1207/gfm-preview/blob/master/src/gfmProvider.ts
// https://github.com/cbreeden/vscode-markdownit
export class MarkdownPreviewEnhancedView implements vscode.TextDocumentContentProvider {
  private _onDidChange = new vscode.EventEmitter<Uri>()
  private _waiting:boolean = false

  /**
   * The key is markdown file fsPath
   * value is MarkdownEngine
   */
  private engineMaps:{[key:string]: MarkdownEngine} = {} 

  /**
   * The key is markdown file fsPath
   * value is JSAndCssFiles
   */
  private jsAndCssFilesMaps: {[key:string]: string[]} = {}

  /**
   * The key is markdown file fsPath
   * value is whether it's presentation mode or not.
   */
  private isPresentationModeMaps: {[key:string]: boolean} = {}

  /**
   * The key is markdown file fsPath
   * value is yamlConfig got from calling `parseMD` function.  
   */
  private yamlConfigMaps: {[key:string]: object} = {}

  private config:MarkdownPreviewEnhancedConfig

  public constructor(private context: vscode.ExtensionContext) {
    this.config = MarkdownPreviewEnhancedConfig.getCurrentConfig()

    mume.init() // init markdown-preview-enhanced
    .then(()=> {
      mume.onDidChangeConfigFile(this.refreshAllPreviews.bind(this))

      MarkdownEngine.onModifySource(this.modifySource.bind(this))
    })
  }

  private refreshAllPreviews() {
    vscode.workspace.textDocuments.forEach(document => {
      if (document.uri.scheme === 'markdown-preview-enhanced') {
        // this.update(document.uri);
        this._onDidChange.fire(document.uri)
      }
    })
  }

  /**
   * modify markdown source, append `result` after corresponding code chunk.
   * @param codeChunkData 
   * @param result 
   * @param filePath 
   */
  private async modifySource(codeChunkData:mume.CodeChunkData, result:string, filePath:string):Promise<string> {
    function insertResult(i:number, editor:TextEditor) {
      const lineCount = editor.document.lineCount
      if (i + 1 < lineCount && editor.document.lineAt(i + 1).text.startsWith('<!-- code_chunk_output -->')) {
        // TODO: modify exited output 
        let start = i + 1
        let end = i + 2
        while (end < lineCount) {
          if (editor.document.lineAt(end).text.startsWith('<!-- /code_chunk_output -->')){
            break
          }
          end += 1
        }

        // if output not changed, then no need to modify editor buffer
        let r = ""
        for (let i = start+2; i < end-1; i++) {
          r += editor.document.lineAt(i).text+'\n'
        }
        if (r === result+'\n') return "" // no need to modify output

        editor.edit((edit)=> {
          edit.replace(new vscode.Range(
            new vscode.Position(start + 2, 0),
            new vscode.Position(end-1, 0)
          ), result+'\n')
        })
        return ""
      } else {
        editor.edit((edit)=> {
          edit.insert(new vscode.Position(i+1, 0), `<!-- code_chunk_output -->\n\n${result}\n\n<!-- /code_chunk_output -->\n`)
        })
        return ""
      }
    }

    const visibleTextEditors = vscode.window.visibleTextEditors
    for (let i = 0; i < visibleTextEditors.length; i++) {
      const editor = visibleTextEditors[i]
      if (editor.document.uri.fsPath === filePath) {

        let codeChunkOffset = 0,
            targetCodeChunkOffset = codeChunkData.options['code_chunk_offset']

        const lineCount = editor.document.lineCount
        for (let i = 0; i < lineCount; i++) {
          const line = editor.document.lineAt(i)
          if (line.text.match(/^```(.+)\"?cmd\"?\s*\:/)) {
            if (codeChunkOffset === targetCodeChunkOffset) {
              i = i + 1
              while (i < lineCount) {
                if (editor.document.lineAt(i).text.match(/^\`\`\`\s*/)) {
                  break
                }
                i += 1
              }
              return insertResult(i, editor)
            } else {
              codeChunkOffset++
            }
          } else if (line.text.match(/\@import\s+(.+)\"?cmd\"?\s*\:/)) {
            if (codeChunkOffset === targetCodeChunkOffset) {
              // console.log('find code chunk' )
              return insertResult(i, editor)
            } else {
              codeChunkOffset++
            }
          }
        }
        break
      }
    }
    return ""
  }

  /**
   * return markdown engine of sourceUri
   * @param sourceUri 
   */
  public getEngine(sourceUri:Uri):MarkdownEngine {
    return this.engineMaps[sourceUri.fsPath]
  }

  /**
   * check if the markdown preview is on for the textEditor
   * @param textEditor 
   */
  public isPreviewOn(sourceUri:Uri) {
    if (useSinglePreview()) {
      return Object.keys(this.engineMaps).length >= 1
    }
    return this.getEngine(sourceUri)
  }

  /**
   * remove engine from this.engineMaps
   * @param previewUri 
   */
  public destroyEngine(previewUri: Uri) {
    delete(previewUri['markdown_source'])

    if (useSinglePreview()) {
      return this.engineMaps = {}
    }
    const sourceUri = vscode.Uri.parse(previewUri.query)
    const engine = this.getEngine(sourceUri)
    if (engine) {
      // console.log('engine destroyed')
      this.engineMaps[sourceUri.fsPath] = null // destroy engine 
    }
  } 

  /**
   * Initialize MarkdownEngine for this markdown file
   */
  public initMarkdownEngine(sourceUri: Uri):MarkdownEngine {
    let engine = this.getEngine(sourceUri)
    if (!engine) {
      engine = new MarkdownEngine(
        {
          filePath: sourceUri.fsPath,
          projectDirectoryPath: vscode.workspace.rootPath,
          config: this.config
        })
      this.engineMaps[sourceUri.fsPath] = engine
    }
    return engine
  }

  private getJSAndCssFiles(fsPath:string) {
    if (!this.jsAndCssFilesMaps[fsPath]) return ''

    let output = ''
    this.jsAndCssFilesMaps[fsPath].forEach((sourcePath)=> {
      let absoluteFilePath = sourcePath
      if (sourcePath[0] === '/') {
        absoluteFilePath = 'file:///' + path.resolve(vscode.workspace.rootPath, '.' + sourcePath)
      } else if (sourcePath.match(/^file:\/\//) || sourcePath.match(/^https?\:\/\//)) {
        // do nothing 
      } else {
        absoluteFilePath = 'file:///' + path.resolve(path.dirname(fsPath), sourcePath)
      }

      if (absoluteFilePath.endsWith('.js')) {
        output += `<script type="text/javascript" src="${absoluteFilePath}"></script>`
      } else { // css
        output += `<link rel="stylesheet" href="${absoluteFilePath}">`
      }
    })
    return output
  }

  public provideTextDocumentContent(previewUri: Uri)
  : Thenable<string> {
    // console.log(sourceUri, uri, vscode.workspace.rootPath)

    let sourceUri:Uri
    if (useSinglePreview()) {
      sourceUri = singlePreviewSouceUri
    } else {
      sourceUri = vscode.Uri.parse(previewUri.query)
    }

    // console.log('open preview for source: ' + sourceUri.toString())

		let initialLine: number | undefined = undefined;
		const editor = vscode.window.activeTextEditor;
		if (editor && editor.document.uri.fsPath === sourceUri.fsPath) {
			initialLine = editor.selection.active.line;
		}

    return vscode.workspace.openTextDocument(sourceUri).then(document => {
      const text = document.getText()

      const config = Object.assign({}, this.config, {
				previewUri: previewUri.toString(),
				sourceUri: sourceUri.toString(),
        initialLine: initialLine,
        isPresentationMode: this.isPresentationModeMaps[sourceUri.fsPath]
      })

      let html = '<div class="markdown-spinner"> Loading Markdown\u2026 </div>'
      let engine = this.getEngine(sourceUri)
      if (engine) {
        html = engine.getCachedHTML()
      } else {
        engine = this.initMarkdownEngine(sourceUri)
      }

      const htmlTemplate = `<!DOCTYPE html>
      <html>
      <head>
        <meta http-equiv="Content-type" content="text/html;charset=UTF-8">
        <meta id="vscode-markdown-preview-enhanced-data" data-config="${mume.utility.escapeString(JSON.stringify(config))}">
        <meta charset="UTF-8">

        ${engine.generateStylesForPreview(this.isPresentationModeMaps[sourceUri.fsPath])}
        <link rel="stylesheet" href="file:///${path.resolve(this.context.extensionPath, './styles/preview.css')}">

        ${this.getJSAndCssFiles(sourceUri.fsPath)}
        
        <base href="${document.uri.toString(true)}">
      </head>
      <body class="preview-container">
        <div class="mume" for="preview" ${this.isPresentationModeMaps[sourceUri.fsPath] ? 'data-presentation-mode' : ''}>
          ${html}
        </div>
        
        <div class="refreshing-icon"></div>

        <div id="md-toolbar">
          <div class="back-to-top-btn btn"><span>⬆︎</span></div>
          <div class="refresh-btn btn"><span>⟳︎</span></div>
          <div class="sidebar-toc-btn btn"><span>§</span></div>
        </div>

        <div id="image-helper-view">
          <h4>Image Helper</h4>
          <div class="upload-div">
            <label>Link</label>
            <input type="text" class="url-editor" placeholder="enter image URL here, then press \'Enter\' to insert.">

            <div class="splitter"></div>

            <label class="copy-label">Copy image to root /assets folder</label>
            <div class="drop-area paster">
              <p class="paster"> Drop image file here or click me </p>
              <input class="file-uploader paster" type="file" style="display:none;" multiple="multiple" >
            </div>

            <div class="splitter"></div>

            <label>Upload</label>
            <div class="drop-area uploader">
              <p class="uploader">Drop image file here or click me</p>
              <input class="file-uploader uploader" type="file" style="display:none;" multiple="multiple" >
            </div>
            <div class="uploader-choice">
              <span>use</span>
              <select class="uploader-select">
                <option>imgur</option>
                <option>sm.ms</option>
              </select>
              <span> to upload images</span>
            </div>
          </div>
        </div>

      </body>
      ${engine.generateScriptsForPreview(this.isPresentationModeMaps[sourceUri.fsPath], this.yamlConfigMaps[sourceUri.fsPath])}
      <script src="${path.resolve(this.context.extensionPath, './out/src/markdown-preview-enhanced-webview.js')}"></script>
      </html>`

      return htmlTemplate
    })
  }

  public updateMarkdown(sourceUri:Uri, triggeredBySave?:boolean) {
    const engine = this.getEngine(sourceUri)
    // console.log('updateMarkdown: ' + Object.keys(this.engineMaps).length)
    if (!engine) return 

    vscode.workspace.openTextDocument(sourceUri).then(document => {
      const text = document.getText()

      vscode.commands.executeCommand(
        '_workbench.htmlPreview.postMessage',
        getPreviewUri(sourceUri),
        {
          type: 'start-parsing-markdown',
        })

      engine.parseMD(text, {isForPreview: true, useRelativeFilePath: false, hideFrontMatter: false, triggeredBySave})
      .then(({markdown, html, tocHTML, JSAndCssFiles, yamlConfig})=> {
        this.yamlConfigMaps[sourceUri.fsPath] = yamlConfig

        // check JSAndCssFiles 
        if (JSON.stringify(JSAndCssFiles) !== JSON.stringify(this.jsAndCssFilesMaps[sourceUri.fsPath]) || yamlConfig['isPresentationMode'] ) {
          this.jsAndCssFilesMaps[sourceUri.fsPath] = JSAndCssFiles
          this.isPresentationModeMaps[sourceUri.fsPath] = yamlConfig['isPresentationMode']
          // restart iframe 
          this._onDidChange.fire(getPreviewUri(sourceUri))
        } else {
          this.isPresentationModeMaps[sourceUri.fsPath] = false
          vscode.commands.executeCommand(
            '_workbench.htmlPreview.postMessage',
            getPreviewUri(sourceUri),
            {
              type: 'update-html',
              html: html,
              tocHTML: tocHTML,
              totalLineCount: document.lineCount,
              sourceUri: sourceUri.toString(),
              id: yamlConfig.id || '',
              class: yamlConfig.class || ''
          })
        }
      })
    })
  }

  public refreshPreview(sourceUri: Uri) {
    const engine = this.getEngine(sourceUri)
    if (engine) {
      engine.clearCaches()
      // restart iframe 
      this._onDidChange.fire(getPreviewUri(sourceUri))
    }
  }

  public openInBrowser(sourceUri: Uri) {
    const engine = this.getEngine(sourceUri)
    if (engine) {
      engine.openInBrowser({})
      .catch((error)=> {
        vscode.window.showErrorMessage(error)
      })
    }
  }

  public saveAsHTML(sourceUri: Uri, offline:boolean) {
    const engine = this.getEngine(sourceUri)
    if (engine) {
      engine.htmlExport({offline})
      .then((dest)=> {
        vscode.window.showInformationMessage(`File ${path.basename(dest)} was created at path: ${dest}`)
      })
      .catch((error)=> {
        vscode.window.showErrorMessage(error)
      })
    }
  }

  public phantomjsExport(sourceUri: Uri, type: string) {
    const engine = this.getEngine(sourceUri)
    if (engine) {
      engine.phantomjsExport({fileType: type})
      .then((dest)=> {
        vscode.window.showInformationMessage(`File ${path.basename(dest)} was created at path: ${dest}`)
      })
      .catch((error)=> {
        vscode.window.showErrorMessage(error)
      })
    }  
  }

  public princeExport(sourceUri: Uri) {
    const engine = this.getEngine(sourceUri)
    if (engine) {
      engine.princeExport({})
      .then((dest)=> {
        if (dest.endsWith('?print-pdf'))  // presentation pdf
          vscode.window.showInformationMessage(`Please copy and open the link: { ${dest.replace(/\_/g, '\\_')} } in Chrome then Print as Pdf.`)
        else 
          vscode.window.showInformationMessage(`File ${path.basename(dest)} was created at path: ${dest}`)
      })
      .catch((error)=> {
        vscode.window.showErrorMessage(error)
      })
    }
  }

  public eBookExport(sourceUri: Uri, fileType:string) {
    const engine = this.getEngine(sourceUri)
    if (engine) {
      engine.eBookExport({fileType})
      .then((dest)=> {
        vscode.window.showInformationMessage(`eBook ${path.basename(dest)} was created as path: ${dest}`)
      })
      .catch((error)=> {
        vscode.window.showErrorMessage(error)
      })
    }
  }

  public pandocExport(sourceUri) {
    const engine = this.getEngine(sourceUri)
    if (engine) {
      engine.pandocExport({})
      .then((dest)=> {
        vscode.window.showInformationMessage(`Document ${path.basename(dest)} was created as path: ${dest}`)
      })
      .catch((error)=> {
        vscode.window.showErrorMessage(error)
      })
    }
  }

  public markdownExport(sourceUri) {
    const engine = this.getEngine(sourceUri)
    if (engine) {
      engine.markdownExport({})
      .then((dest)=> {
        vscode.window.showInformationMessage(`Document ${path.basename(dest)} was created as path: ${dest}`)
      })
      .catch((error)=> {
        vscode.window.showErrorMessage(error)
      })
    }
  }

  /*
  public cacheSVG(sourceUri: Uri, code:string, svg:string) {
    const engine = this.getEngine(sourceUri)
    if (engine) {
      engine.cacheSVG(code, svg)
    }
  }
  */

  public cacheCodeChunkResult(sourceUri: Uri, id:string, result:string) {
    const engine = this.getEngine(sourceUri)
    if (engine) {
      engine.cacheCodeChunkResult(id, result)
    }
  }

  public runCodeChunk(sourceUri: Uri, codeChunkId: string) {
    const engine = this.getEngine(sourceUri)
    if (engine) {
      engine.runCodeChunk(codeChunkId)
      .then(()=> {
        this.updateMarkdown(sourceUri)
      })
    }
  }

  public runAllCodeChunks(sourceUri) {
    const engine = this.getEngine(sourceUri)
    if (engine) {
      engine.runAllCodeChunks()
      .then(()=> {
        this.updateMarkdown(sourceUri)
      })
    }
  }

  get onDidChange(): Event<Uri> {
    return this._onDidChange.event
  }

  public update(sourceUri: Uri) {
    // console.log('update')
		if (!this._waiting) {
			this._waiting = true;
			setTimeout(() => {
				this._waiting = false;
				// this._onDidChange.fire(uri);
        this.updateMarkdown(sourceUri)
			}, 300)
		}
  }

  public updateConfiguration() {
    const newConfig = MarkdownPreviewEnhancedConfig.getCurrentConfig()
    if (!this.config.isEqualTo(newConfig)) {
      this.config = newConfig

      for (let fsPath in this.engineMaps) {
        const engine = this.engineMaps[fsPath]
        engine.updateConfiguration(newConfig)
      }

      // update all generated md documents
			vscode.workspace.textDocuments.forEach(document => {
				if (document.uri.scheme === 'markdown-preview-enhanced') {
					// this.update(document.uri);
          this._onDidChange.fire(document.uri)
				}
			})
    }
  }

  public openImageHelper(sourceUri:Uri) {
    if (sourceUri.scheme === 'markdown-preview-enhanced') {
      return vscode.window.showWarningMessage('Please focus a markdown file.')
    } else if (!this.isPreviewOn(sourceUri)) {
      return vscode.window.showWarningMessage('Please open preview first.')
    } else {
      vscode.commands.executeCommand(
        '_workbench.htmlPreview.postMessage',
        getPreviewUri(sourceUri),
        {
          type: 'open-image-helper'
        })
    }
  }

}

/**
 * check whehter to use only one preview or not
 */
export function useSinglePreview() {
  const config = vscode.workspace.getConfiguration('markdown-preview-enhanced')
  return config.get<boolean>('singlePreview')
}


export function getPreviewUri(uri: vscode.Uri) {
	if (uri.scheme === 'markdown-preview-enhanced') {
		return uri
	}
  
  
  let previewUri:Uri
  if (useSinglePreview()) {
    previewUri = uri.with({
      scheme: 'markdown-preview-enhanced',
      path: 'single-preview.rendered', 
    })
    singlePreviewSouceUri = uri
  } else {
    previewUri = uri.with({
      scheme: 'markdown-preview-enhanced',
      path: uri.path + '.rendered',
      query: uri.toString()
    })
  }
  return previewUri
}


export function isMarkdownFile(document: vscode.TextDocument) {
	return document.languageId === 'markdown'
		&& document.uri.scheme !== 'markdown-preview-enhanced' // prevent processing of own documents
}