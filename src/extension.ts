import * as path from "path";
import * as vscode from "vscode";

const viewType = "anyapdf.pdfViewer";

class PdfDocument implements vscode.CustomDocument {
	private readonly disposeEmitter = new vscode.EventEmitter<void>();
	readonly onDidDispose = this.disposeEmitter.event;

	constructor(readonly uri: vscode.Uri, readonly bytes: Uint8Array) {}

	dispose(): void {
		this.disposeEmitter.fire();
		this.disposeEmitter.dispose();
	}
}

class PdfEditorProvider implements vscode.CustomReadonlyEditorProvider<PdfDocument> {
	private readonly panels = new Set<vscode.WebviewPanel>();
	private activePanel: vscode.WebviewPanel | undefined;
	private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	private readonly disposables: vscode.Disposable[] = [];

	constructor(private readonly context: vscode.ExtensionContext) {
		this.status.name = "AnyaPDF Page and Zoom";
		this.disposables.push(this.status);
		this.disposables.push(vscode.commands.registerCommand("anyapdf.zoomIn", () => this.post({ type: "action", action: "zoomIn" })));
		this.disposables.push(vscode.commands.registerCommand("anyapdf.zoomOut", () => this.post({ type: "action", action: "zoomOut" })));
		this.disposables.push(vscode.commands.registerCommand("anyapdf.zoomReset", () => this.post({ type: "action", action: "zoomReset" })));
		this.disposables.push(vscode.commands.registerCommand("anyapdf.fitWidth", () => this.post({ type: "action", action: "fitWidth" })));
		this.disposables.push(vscode.commands.registerCommand("anyapdf.find", () => this.post({ type: "action", action: "find" })));
		this.disposables.push(vscode.commands.registerCommand("anyapdf.nextPage", () => this.post({ type: "action", action: "nextPage" })));
		this.disposables.push(vscode.commands.registerCommand("anyapdf.prevPage", () => this.post({ type: "action", action: "prevPage" })));
		this.disposables.push(vscode.commands.registerCommand("anyapdf.goToPage", async () => {
			const value = await vscode.window.showInputBox({ prompt: "Go to PDF page", placeHolder: "Page number" });
			if (value) {
				const page = Number.parseInt(value, 10);
				if (Number.isFinite(page) && page > 0) {
					this.post({ type: "action", action: "goToPage", page });
				}
			}
		}));
	}

	async openCustomDocument(uri: vscode.Uri): Promise<PdfDocument> {
		try {
			const bytes = await vscode.workspace.fs.readFile(uri);
			return new PdfDocument(uri, bytes);
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			void vscode.window.showErrorMessage(`AnyaPDF could not read this file: ${detail}`);
			throw error;
		}
	}

	async resolveCustomEditor(document: PdfDocument, panel: vscode.WebviewPanel): Promise<void> {
		panel.webview.options = {
			enableScripts: true,
			localResourceRoots: [
				vscode.Uri.joinPath(this.context.extensionUri, "media"),
				vscode.Uri.joinPath(this.context.extensionUri, "out", "media")
			]
		};
		panel.webview.html = this.getHtml(panel.webview);
		this.panels.add(panel);
		this.refreshActivePanel(panel);

		const ready = panel.webview.onDidReceiveMessage((message: { type?: string; page?: number; total?: number; zoom?: number }) => {
			if (message.type === "ready") {
				const configuration = vscode.workspace.getConfiguration("anyapdf");
				// Webview messaging transfers ArrayBuffer reliably; TypedArrays may arrive as plain objects.
				const pdfData = new ArrayBuffer(document.bytes.byteLength);
				new Uint8Array(pdfData).set(document.bytes);
				void panel.webview.postMessage({
					type: "loadPdf",
					data: pdfData,
					defaultZoom: configuration.get<number>("defaultZoom", 100),
					fitToWidthOnOpen: configuration.get<boolean>("fitToWidthOnOpen", true)
				});
			} else if (message.type === "requestStatus") {
				void panel.webview.postMessage({ type: "requestStatus" });
			} else if (message.type === "status") {
				panel.title = path.basename(document.uri.fsPath);
				if (this.activePanel === panel) {
					this.status.text = `Page ${message.page ?? 1}/${message.total ?? 1} · ${message.zoom ?? 100}%`;
					this.status.show();
				}
			}
		});
		const viewState = panel.onDidChangeViewState(() => this.refreshActivePanel(panel));
		const closed = panel.onDidDispose(() => {
			this.panels.delete(panel);
			if (this.activePanel === panel) {
				this.activePanel = undefined;
				this.selectActivePanel();
			}
			ready.dispose();
			viewState.dispose();
		});
		panel.onDidDispose(() => closed.dispose());
	}

	private getHtml(webview: vscode.Webview): string {
		const nonce = getNonce();
		const htmlPath = vscode.Uri.joinPath(this.context.extensionUri, "media", "viewer.html");
		const viewerUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "out", "media", "viewer.js"));
		const workerUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "out", "media", "pdf.worker.min.mjs"));
		const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "viewer.css"));
		const fs = require("fs") as typeof import("fs");
		let html = fs.readFileSync(htmlPath.fsPath, "utf8");
		for (const [key, value] of Object.entries({
			cspSource: webview.cspSource,
			nonce,
			viewerUri: viewerUri.toString(),
			workerUri: workerUri.toString(),
			cssUri: cssUri.toString()
		})) {
			html = html.split(`{{${key}}}`).join(value);
		}
		return html;
	}

	private post(message: unknown): void {
		this.activePanel?.webview.postMessage(message);
	}

	private refreshActivePanel(changed: vscode.WebviewPanel): void {
		const previousPanel = this.activePanel;
		if (changed.active) {
			this.activePanel = changed;
		} else if (this.activePanel === changed) {
			this.activePanel = undefined;
			this.selectActivePanel();
		}
		if (this.activePanel) {
			this.status.show();
			if (this.activePanel !== previousPanel) {
				void this.activePanel.webview.postMessage({ type: "requestStatus" });
			}
		} else {
			this.status.hide();
		}
	}

	private selectActivePanel(): void {
		this.activePanel = [...this.panels].find((panel) => panel.active);
		if (this.activePanel) {
			this.status.show();
			void this.activePanel.webview.postMessage({ type: "requestStatus" });
		} else {
			this.status.hide();
		}
	}

	dispose(): void {
		this.disposables.forEach((item) => item.dispose());
		this.panels.clear();
	}
}

export function activate(context: vscode.ExtensionContext): void {
	const provider = new PdfEditorProvider(context);
	context.subscriptions.push(provider);
	context.subscriptions.push(vscode.window.registerCustomEditorProvider(viewType, provider, {
		supportsMultipleEditorsPerDocument: false
	}));
}

export function deactivate(): void {}

function getNonce(): string {
	let value = "";
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
	for (let index = 0; index < 32; index++) {
		value += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
	}
	return value;
}
