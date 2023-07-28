import * as vscode from 'vscode';
import { Disposable, disposeAll } from './dispose';
import { getNonce } from './util';

import * as duckdb from 'duckdb';

/**
 * Define the document (the data model) used for paw draw files.
 */
class ParquetDocument extends Disposable implements vscode.CustomDocument {

	static async create(
		uri: vscode.Uri,
		backupId: string | undefined,
	): Promise<ParquetDocument | PromiseLike<ParquetDocument>> {
		// If we have a backup, read that. Otherwise read the resource from the workspace
		const trueURI = typeof backupId === 'string' ? vscode.Uri.parse(backupId) : uri;
		return new ParquetDocument(trueURI);
	}

	private readonly _uri: vscode.Uri;
	private readonly _db: duckdb.Database;

	private constructor(uri: vscode.Uri) {
		super();
		this._uri = uri;
		this._db = new duckdb.Database(':memory:');
		this.db.exec(`CREATE VIEW data AS SELECT * FROM read_parquet('${uri.path}');`);
	}

	public get uri() { return this._uri; }
	public get db() { return this._db; }

	private readonly _onDidDispose = this._register(new vscode.EventEmitter<void>());
	/**
	 * Fired when the document is disposed of.
	 */
	public readonly onDidDispose = this._onDidDispose.event;

	/**
	 * Called by VS Code when there are no more references to the document.
	 *
	 * This happens when all editors for it have been closed.
	 */
	dispose(): void {
		this._onDidDispose.fire();
		super.dispose();
	}

	verifySyntax(sql: string, callback: (msg: object) => void): void {
		this.db.all(`EXPLAIN\n${sql}`, function(err, res) {
			if (err) {
				callback({type: 'syntax', success: false, message: err.message });
			}
			else {
				callback({type: 'syntax', success: true});
			}
		});
	}

	runQuery(sql: string, callback: (msg: object) => void): void {
		this.db.all(sql, function(err, res) {
			if (err) {
				callback({type: 'query', valid: false});
			}
			else {
				callback({type: 'query', valid: true, results: res });
			}
		});
	}
}


export class ParquetDocumentProvider implements vscode.CustomReadonlyEditorProvider<ParquetDocument> {

	public static register(context: vscode.ExtensionContext): vscode.Disposable {
		return vscode.window.registerCustomEditorProvider(
			ParquetDocumentProvider.viewType,
			new ParquetDocumentProvider(context),
			{supportsMultipleEditorsPerDocument: false},
		);
	}

	private static readonly viewType = 'parquetExplorer.explorer';

	constructor(
		private readonly _context: vscode.ExtensionContext
	) { }

	//#region CustomEditorProvider

	async openCustomDocument(
		uri: vscode.Uri,
		openContext: { backupId?: string },
		_token: vscode.CancellationToken
	): Promise<ParquetDocument> {
		const document: ParquetDocument = await ParquetDocument.create(uri, openContext.backupId);

		return document;
	}

	async resolveCustomEditor(
		document: ParquetDocument,
		webviewPanel: vscode.WebviewPanel,
		_token: vscode.CancellationToken
	): Promise<void> {
		// Setup initial content for the webview
		webviewPanel.webview.options = {
			enableScripts: true,
		};

		// document.db.all("SELECT * FROM data LIMIT 30", function(err, res) {
		// 	if (err) {
		// 		throw err;
		// 	}
			
		// 	console.log(res);
		// 	// webviewPanel.webview.html = `<html>${res[0].column0}</html>`;
		// });

		webviewPanel.webview.html = this.getHtmlForWebview(webviewPanel.webview);

		webviewPanel.webview.onDidReceiveMessage(e => this.onMessage(document, webviewPanel, e));

		// // Wait for the webview to be properly ready before we init
		// webviewPanel.webview.onDidReceiveMessage(e => {
		// 	if (e.type === 'ready') {
		// 		this.postMessage(webviewPanel, 'init', {});
		// 	}
		// });
	}


	/**
	 * Get the static HTML used for in our editor's webviews.
	 */
	private getHtmlForWebview(webview: vscode.Webview): string {
		// Local path to script and css for the webview
		const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(
			this._context.extensionUri, 'media', 'parquetExplorer.js'));

		const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(
			this._context.extensionUri, 'media', 'parquetExplorer.css'));
		
		const codeInputJsUri = webview.asWebviewUri(vscode.Uri.joinPath(
			this._context.extensionUri, 'media', 'code-input.min.js'));

		const codeInputCssUri = webview.asWebviewUri(vscode.Uri.joinPath(
			this._context.extensionUri, 'media', 'code-input.min.css'));

		const indentJsUri = webview.asWebviewUri(vscode.Uri.joinPath(
			this._context.extensionUri, 'media', 'indent.min.js'));

		const prismJsUri = webview.asWebviewUri(vscode.Uri.joinPath(
			this._context.extensionUri, 'media', 'prism.js'));

		const prismCssUri = webview.asWebviewUri(vscode.Uri.joinPath(
			this._context.extensionUri, 'media', 'prism.css'));

		const loadingIconUri = webview.asWebviewUri(vscode.Uri.joinPath(
			this._context.extensionUri, 'media', 'loading_icon.gif'));


		// Use a nonce to whitelist which scripts can be run
		const nonce = getNonce();

		return `
			<!DOCTYPE html>
			<html lang="en">
			<head>
				<meta charset="UTF-8">

				<!--
				Use a content security policy to only allow loading images from https or from our extension directory,
				and only allow scripts that have a specific nonce.
				-->
				<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} blob:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">

				<meta name="viewport" content="width=device-width, initial-scale=1.0">

				<script nonce="${nonce}" src="${prismJsUri}"></script>
				<link rel="stylesheet" href="${prismCssUri}">

				<script nonce="${nonce}" src="${codeInputJsUri}"></script>
				<link rel="stylesheet" href="${codeInputCssUri}">

				<script nonce="${nonce}" src="${indentJsUri}"></script>

				<script nonce="${nonce}" src="${jsUri}"></script>
				<link rel="stylesheet" href="${cssUri}">

				<title>Parquet Explorer</title>
			</head>
			<body>
				<code-input nonce="${nonce}" lang="SQL"></code-input>
				<center id="resultsWrapper">
					<table id="results">
						<thead id="resultsHeader"></thead>
						<tbody id="resultsBody"></tbody>
					</table>
					<img id="loadingIcon" src="${loadingIconUri}" />
				</center>
			</body>
			
			</html>
		`;
	}


	private postMessage(panel: vscode.WebviewPanel, message: object): void {
		panel.webview.postMessage(message);
	}

	private onMessage(document: ParquetDocument, panel: vscode.WebviewPanel, message: any) {
		switch (message.type) {
			case 'syntax':
				document.verifySyntax(message.sql, (msg: object) => this.postMessage(panel, msg));
				return;
			case 'query':
				document.runQuery(message.sql, (msg: object) => this.postMessage(panel, msg));
				return;

		}
	}
}
