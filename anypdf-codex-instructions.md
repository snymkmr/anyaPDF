# AnyPDF — Codex Build Instructions

Paste everything below the line into Codex.

---

You are building a VS Code extension. Follow these instructions exactly. Ask for clarification only if a step is truly ambiguous; otherwise make the standard choice and note it.

## 1. What to build

**AnyPDF** — a lightweight, read-only PDF viewer for VS Code, the fourth member of an existing extension suite (AnyXML, AnyCSV, AnyJSON) by publisher **SanyamKumar**. One-line description: "View PDF documents in Visual Studio Code."

Scope (must-have):

- Open any `.pdf` file in a custom read-only editor tab.
- Render pages with pdf.js; lazy-render pages as the user scrolls (never render the whole document upfront).
- Toolbar: previous/next page, go-to-page input (e.g. "3 / 42"), zoom in / out / reset, fit-to-width toggle.
- Text search across the document with match count and next/previous match navigation, current match highlighted.
- Native text selection and copy (render the pdf.js text layer).
- Document outline (table of contents) in a side pane when the PDF has one; clicking an entry jumps to the page.
- Status bar item: "Page 3/42 · 125%".
- Keyboard shortcuts: Ctrl+= / Ctrl+- zoom, Ctrl+0 reset zoom, Ctrl+F find, PageUp/PageDown page navigation.
- Follow the VS Code color theme (use `var(--vscode-*)` CSS variables). Friendly error message for corrupt or password-protected PDFs.

Explicit non-goals (do NOT build): editing, annotations, form filling, signing, merging/splitting, printing. No UI frameworks — vanilla TypeScript + minimal CSS. No full pdf.js `viewer.html` build; minimal custom UI only.

## 2. Project setup

- Scaffold with `yo code`, extension type "New Extension (TypeScript)". (If `yo` is unavailable, create the standard layout manually: `package.json`, `src/extension.ts`, `tsconfig.json`.)
- TypeScript `strict: true`.
- Bundler: webpack (the yo code default) — keep the default config, add `pdfjs-dist` as a dependency (pin `^4.x`).
- Copy the provided icon to `images/anypdf-icon.png` (256×256 PNG). Reference it in package.json as `"icon": "images/anypdf-icon.png"`.

## 3. package.json manifest

- `"name": "anypdf"`, `"displayName": "AnyPDF"`, `"publisher": "SanyamKumar"`, `"version": "0.1.0"`
- `"description": "View PDF documents in Visual Studio Code."`
- `"engines": { "vscode": "^1.85.0" }`
- `"categories": ["Viewers"]`, `"keywords": ["pdf", "viewer"]`
- `"activationEvents": ["onCustomEditor:anypdf.pdfViewer"]`
- `contributes.customEditors`: one entry — `"viewType": "anypdf.pdfViewer"`, `"displayName": "AnyPDF Viewer"`, `"selector": [{ "filenamePattern": "*.pdf" }]`, `"priority": "default"`
- `contributes.commands`: `anypdf.zoomIn`, `anypdf.zoomOut`, `anypdf.zoomReset`, `anypdf.fitWidth`, `anypdf.goToPage`, `anypdf.find`, `anypdf.nextPage`, `anypdf.prevPage` — each with a clear `title`.
- `contributes.keybindings` mapping the shortcuts from section 1 to those commands, with a sensible `when` clause.
- `contributes.configuration`: `anypdf.defaultZoom` (number, default 100), `anypdf.fitToWidthOnOpen` (boolean, default true).
- Standard fields: `repository`, `homepage` (https://sanyam.dev), `license` (MIT), `bugs` url.

## 4. Extension host code (`src/extension.ts`)

- Implement `vscode.CustomReadonlyEditorProvider<vscode.CustomDocument>`; register with `{ viewType: 'anypdf.pdfViewer', supportsMultipleEditorsPerDocument: false }`.
- `openCustomDocument(uri)`: read bytes via `vscode.workspace.fs.readFile(uri)`; return a CustomDocument holding the `Uint8Array` and the uri.
- `resolveCustomEditor(document, webviewPanel)`:
  - `webviewPanel.webview.options = { enableScripts: true, localResourceRoots: [media dir, extension dir] }`.
  - Load `media/viewer.html`; convert local paths with `webview.asWebviewUri`.
  - After the webview signals ready, `postMessage` the PDF bytes (`Uint8Array` — structured clone handles it; do not base64-encode large files into the HTML).
  - Wire commands/keybindings to `postMessage` actions on the active panel; track the active AnyPDF panel.
  - Update a status bar item (`vscode.window.createStatusBarItem`) on page/zoom messages from the webview; show it only while an AnyPDF editor is active; dispose on close.
- Handle binary read errors gracefully (surface `vscode.window.showErrorMessage`).

## 5. Webview (`media/viewer.html`, `media/viewer.css`, `media/viewer.js`)

- On load, signal ready; on receiving the PDF bytes: `pdfjsLib.getDocument({ data })`.
- Set `pdfjsLib.GlobalWorkerOptions.workerSrc` to the webview URI of `media/pdf.worker.min.mjs` — copy the worker file from `pdfjs-dist/build/` into `media/` at build time (npm script or webpack CopyPlugin). The worker must be bundled locally; never load pdf.js from a CDN.
- Layout: top toolbar (buttons + page input + search box), optional collapsible outline pane on the left, scrollable page container.
- Rendering: one `<div class="page">` per page with a `<canvas>`; use `IntersectionObserver` to render pages only when near the viewport, at `window.devicePixelRatio`-aware scale; render the text layer (`renderTextLayer`) for selection, copy, and search highlighting.
- Search: on query, `getTextContent()` per page (lazily, page by page), collect matches, highlight via the text layer, support Enter/Shift+Enter or next/prev buttons, show "2 of 14", Escape clears.
- Outline: `pdfDocument.getOutline()`; render nested list; resolve each item's destination to a page number and scroll to it on click. Hide the pane if the document has no outline.
- Zoom: levels 25–400%; re-render visible pages on zoom change (debounced); fit-to-width computes scale from container width.
- Theme: all colors from VS Code CSS variables; dark/light automatic.
- Errors: catch getDocument/render failures and show a clean message ("Couldn't open this PDF — the file may be corrupt or password-protected.").

## 6. Docs and packaging

- `README.md`: title, one-line description, Features list, Keyboard shortcuts table, "Read-only viewer" note, license line. Match the terse style of the suite.
- `CHANGELOG.md`: `0.1.0` — initial release.
- `.vscodeignore`: exclude `src/`, `.gitignore`, etc. (keep the standard template; ensure `images/anypdf-icon.png` and the `media/` runtime files are included).
- Verify: `npm install`, `npm run compile` (zero TS errors), `npx vsce package` produces `anypdf-0.1.0.vsix`.

## 7. Definition of done (verify each)

1. `npm run compile` passes with no TypeScript errors.
2. Press F5 → Extension Development Host → open a multi-page PDF: first pages render immediately, the rest render on scroll.
3. Zoom buttons + shortcuts work; page input jumps; search finds/highlights/navigates matches; text selects and copies; outline (if present) navigates.
4. Status bar shows page and zoom while the viewer is focused.
5. `vsce package` succeeds; installing the `.vsix` in a clean window (`code --install-extension anypdf-0.1.0.vsix`) makes double-clicking a PDF open AnyPDF by default.
6. No console errors in the webview developer tools during the above.

Work through sections 2–6 in order. Keep the code simple and comment where the pdf.js integration is non-obvious.
