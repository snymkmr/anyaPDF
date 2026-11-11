import "./promise-compat";
import * as pdfjsLib from "pdfjs-dist";

// A match can span several text items (a phrase split across words or lines), so it is a
// list of [start, end) ranges, one per text item it touches.
type SearchPart = { itemIndex: number; start: number; end: number };
type SearchMatch = { page: number; parts: SearchPart[] };
type TextItemLike = { str: string };
type TextContent = Awaited<ReturnType<pdfjsLib.PDFPageProxy["getTextContent"]>>;
// Where the reader is scrolled to: a page, how far down it the top edge is (a fraction of
// the page height; negative when the gap above the page is showing), and horizontal scroll.
type ViewPosition = { page: number; pageOffset: number; scrollLeft: number };
type SavedState = { zoom?: number; fitWidth?: boolean; page?: number; pageOffset?: number; scrollLeft?: number };

class PasswordCancelledError extends Error {}

const byId = <T extends HTMLElement>(id: string): T => {
	const element = document.getElementById(id);
	if (!element) { throw new Error(`Missing viewer element: ${id}`); }
	return element as T;
};

const reader = byId<HTMLDivElement>("reader");
const pagesElement = byId<HTMLDivElement>("pages");
const pageInput = byId<HTMLInputElement>("page-number");
const pageTotal = byId<HTMLSpanElement>("page-total");
const searchInput = byId<HTMLInputElement>("search-query");
const matchCount = byId<HTMLSpanElement>("match-count");
const zoomResetButton = byId<HTMLButtonElement>("zoom-reset");
const fitWidthButton = byId<HTMLButtonElement>("fit-width");
const outlinePane = byId<HTMLElement>("outline-pane");
const outlineList = byId<HTMLElement>("outline-list");
const outlineToggle = byId<HTMLButtonElement>("toggle-outline");
const errorMessage = byId<HTMLDivElement>("error-message");

const vscode = acquireVsCodeApi();
const workerSrc = document.body.dataset.workerSrc;
let workerUrl: string | undefined;

let pdf: pdfjsLib.PDFDocumentProxy | undefined;
let zoom = 100;
let fitWidth = false;
let currentPage = 1;
let searchGeneration = 0;
let currentMatch = -1;
let matches: SearchMatch[] = [];
let pendingMatchReveal = false;
let lastStatus = "";
const pageElements = new Map<number, HTMLDivElement>();
const pageSizes = new Map<number, { width: number; height: number }>();
const textContents = new Map<number, TextContent>();
const renderedPages = new Set<number>();
const nearbyPages = new Set<number>();
const renderTasks = new Map<number, pdfjsLib.RenderTask>();
const renderTokens = new Map<number, object>();
const pageGap = 18; // Matches the .pages top padding in viewer.css.
// Rendered pages further than this from the pages in view are released to free memory;
// they are drawn again when they come back into view.
const keepRenderedDistance = 3;
let observer: IntersectionObserver | undefined;
let documentGeneration = 0;
let reloadGeneration = 0;
let openSettings = { defaultZoom: 100, fitToWidthOnOpen: false };
let passwordRequest: ((password: string | undefined) => void) | undefined;
let saveStateTimer = 0;

async function initializePdfWorker(): Promise<void> {
	// One worker serves every document this viewer opens, including reloads.
	if (pdfjsLib.GlobalWorkerOptions.workerPort) { return; }
	if (!workerSrc) { throw new Error("PDF worker resource is unavailable."); }
	const response = await fetch(workerSrc);
	if (!response.ok) { throw new Error(`Failed to load PDF worker (${response.status} ${response.statusText}).`); }
	const source = await response.blob();
	workerUrl = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
	try {
		pdfjsLib.GlobalWorkerOptions.workerPort = new Worker(workerUrl, { type: "module" });
	} catch (error) {
		URL.revokeObjectURL(workerUrl);
		workerUrl = undefined;
		throw error;
	}
}

function describeError(error: unknown): string {
	if (error instanceof Error) { return `${error.name}: ${error.message}`; }
	return String(error);
}

function showError(message: string, detail?: string): void {
	errorMessage.textContent = detail ? `${message}\n\n${detail}` : message;
	errorMessage.hidden = false;
}

function getPageScale(pageNumber: number): number {
	const size = pageSizes.get(pageNumber) ?? pageSizes.get(1) ?? { width: 612, height: 792 };
	if (fitWidth) {
		return Math.max(0.1, (reader.clientWidth - 56) / size.width);
	}
	return zoom / 100;
}

function layoutPages(): void {
	const fallback = pageSizes.get(1) ?? { width: 612, height: 792 };
	for (const [pageNumber, element] of pageElements) {
		const size = pageSizes.get(pageNumber) ?? fallback;
		const scale = getPageScale(pageNumber);
		element.style.width = `${Math.round(size.width * scale)}px`;
		element.style.height = `${Math.round(size.height * scale)}px`;
	}
	fitWidthButton.setAttribute("aria-pressed", String(fitWidth));
	zoomResetButton.textContent = `${Math.round(displayZoom())}%`;
	updateStatus();
}

function displayZoom(): number {
	return getPageScale(currentPage) * 100;
}

function updateStatus(force = false): void {
	if (!pdf) { return; }
	const visibleTop = reader.getBoundingClientRect().top;
	const middle = reader.clientHeight / 2;
	let closest = currentPage;
	let distance = Number.POSITIVE_INFINITY;
	for (const [pageNumber, element] of pageElements) {
		const rect = element.getBoundingClientRect();
		const center = rect.top - visibleTop + rect.height / 2;
		const nextDistance = Math.abs(center - middle);
		if (nextDistance < distance) { distance = nextDistance; closest = pageNumber; }
	}
	currentPage = closest;
	pageInput.value = String(currentPage);
	zoomResetButton.textContent = `${Math.round(displayZoom())}%`;
	sendStatus(force);
	scheduleSaveState();
}

function getViewPosition(): ViewPosition | undefined {
	if (!pdf) { return undefined; }
	const readerTop = reader.getBoundingClientRect().top;
	for (const [pageNumber, element] of pageElements) {
		const rect = element.getBoundingClientRect();
		if (rect.bottom > readerTop) {
			const pageOffset = rect.height > 0 ? Math.max(-1, Math.min(1, (readerTop - rect.top) / rect.height)) : 0;
			return { page: pageNumber, pageOffset, scrollLeft: reader.scrollLeft };
		}
	}
	return { page: currentPage, pageOffset: 0, scrollLeft: reader.scrollLeft };
}

function restoreViewPosition(position: ViewPosition): void {
	if (!pdf) { return; }
	const page = Math.max(1, Math.min(pdf.numPages, Math.floor(position.page) || 1));
	const element = pageElements.get(page);
	if (!element) { return; }
	const rect = element.getBoundingClientRect();
	const offset = Number.isFinite(position.pageOffset) ? position.pageOffset : 0;
	reader.scrollTop += rect.top - reader.getBoundingClientRect().top + offset * rect.height;
	reader.scrollLeft = Number.isFinite(position.scrollLeft) ? position.scrollLeft : 0;
	currentPage = page;
}

// Remembers zoom and scroll position so the viewer reopens where it was when VS Code
// recreates it (after switching tabs, or on window reload).
function saveState(): void {
	window.clearTimeout(saveStateTimer);
	saveStateTimer = 0;
	if (!pdf) { return; }
	const state: SavedState = { zoom, fitWidth, ...getViewPosition() };
	vscode.setState(state);
}

function scheduleSaveState(): void {
	if (!saveStateTimer) { saveStateTimer = window.setTimeout(saveState, 150); }
}

function sendStatus(force = false): void {
	if (!pdf) { return; }
	const status = `${currentPage}/${pdf.numPages}/${Math.round(displayZoom())}`;
	if (force || status !== lastStatus) {
		lastStatus = status;
		vscode.postMessage({ type: "status", page: currentPage, total: pdf.numPages, zoom: Math.round(displayZoom()) });
	}
}

function makePageElement(pageNumber: number): HTMLDivElement {
	const page = document.createElement("div");
	page.className = "page";
	page.dataset.page = String(pageNumber);
	page.setAttribute("aria-label", `Page ${pageNumber}`);
	pageElements.set(pageNumber, page);
	pagesElement.append(page);
	return page;
}

function addTextItemIndices(textDivs: HTMLElement[], textContent: TextContent): void {
	let itemIndex = 0;
	for (const item of textContent.items) {
		if (!("str" in item)) { continue; }
		const span = textDivs[itemIndex];
		if (span) { span.dataset.textIndex = String(itemIndex); }
		itemIndex++;
	}
}

function makeRange(span: HTMLElement, start: number, end: number): Range | undefined {
	const walker = document.createTreeWalker(span, NodeFilter.SHOW_TEXT);
	let node = walker.nextNode() as Text | null;
	if (!node) { return undefined; }
	let remainingStart = start;
	let remainingEnd = end;
	while (node) {
		const length = node.textContent?.length ?? 0;
		if (remainingStart <= length) {
			const range = document.createRange();
			range.setStart(node, Math.min(remainingStart, length));
			range.setEnd(node, Math.min(remainingEnd, length));
			return range;
		}
		remainingStart -= length;
		remainingEnd -= length;
		node = walker.nextNode() as Text | null;
	}
	return undefined;
}

// Real glyph advance widths per PDF font, keyed by the Unicode text each glyph produces.
// The text layer draws spans in a generic fallback font stretched to the right total width,
// so positions *inside* a span drift on long lines; these widths place highlights exactly.
type GlyphWidths = Map<string, number>;
type PdfTextItem = { str: string; fontName: string; transform: number[] };
type FontData = { widths?: Record<number, number>; toUnicode?: { _map?: unknown[] }; vertical?: boolean };
const fontWidths = new Map<string, GlyphWidths | null>();
const textItemsByPage = new Map<number, PdfTextItem[]>();

function loadFontWidths(page: pdfjsLib.PDFPageProxy, textContent: TextContent): void {
	for (const item of textContent.items) {
		if (!("fontName" in item) || fontWidths.has(item.fontName) || !page.commonObjs.has(item.fontName)) { continue; }
		const font = page.commonObjs.get(item.fontName) as FontData;
		const unicodeByCode = font.toUnicode?._map;
		if (!font.widths || !Array.isArray(unicodeByCode) || font.vertical) { fontWidths.set(item.fontName, null); continue; }
		const table: GlyphWidths = new Map();
		unicodeByCode.forEach((unicode, code) => {
			const width = font.widths?.[code];
			if (typeof unicode === "string" && typeof width === "number" && !table.has(unicode)) { table.set(unicode, width); }
		});
		fontWidths.set(item.fontName, table.size ? table : null);
	}
}

function getTextItem(pageNumber: number, itemIndex: number): PdfTextItem | undefined {
	let items = textItemsByPage.get(pageNumber);
	if (!items) {
		const content = textContents.get(pageNumber);
		if (!content) { return undefined; }
		items = content.items.filter((item): item is typeof item & PdfTextItem => "str" in item);
		textItemsByPage.set(pageNumber, items);
	}
	return items[itemIndex];
}

/** Start and end of [start, end) as fractions of the item's width, or undefined if any glyph is unknown. */
function glyphFractions(item: PdfTextItem, start: number, end: number): [number, number] | undefined {
	const table = fontWidths.get(item.fontName);
	if (!table || Math.abs(Math.atan2(item.transform[1], item.transform[0])) > 0.001) { return undefined; }
	const measure = (text: string): number | undefined => {
		let total = 0;
		for (const character of text) {
			const width = table.get(character);
			if (width === undefined) { return undefined; }
			total += width;
		}
		return total;
	};
	const before = measure(item.str.slice(0, start));
	const inside = measure(item.str.slice(start, end));
	const after = measure(item.str.slice(end));
	if (before === undefined || inside === undefined || after === undefined) { return undefined; }
	const total = before + inside + after;
	if (total <= 0) { return undefined; }
	return [before / total, (before + inside) / total];
}

function matchRects(pageNumber: number, match: SearchPart, span: HTMLElement): DOMRect[] {
	const item = getTextItem(pageNumber, match.itemIndex);
	const fractions = item ? glyphFractions(item, match.start, match.end) : undefined;
	if (fractions) {
		const spanRect = span.getBoundingClientRect();
		return [new DOMRect(spanRect.left + spanRect.width * fractions[0], spanRect.top, spanRect.width * (fractions[1] - fractions[0]), spanRect.height)];
	}
	// Fallback (rotated text, unknown glyphs): measure with the text layer's own font.
	const range = makeRange(span, match.start, match.end);
	return range ? Array.from(range.getClientRects()) : [];
}

function paintHighlights(pageNumber: number): void {
	const page = pageElements.get(pageNumber);
	if (!page) { return; }
	let highlightLayer = page.querySelector<HTMLDivElement>(".highlights");
	const textLayer = page.querySelector<HTMLDivElement>(".textLayer");
	if (!highlightLayer || !textLayer) { return; }
	highlightLayer.replaceChildren();
	const pageRect = page.getBoundingClientRect();
	for (let matchIndex = 0; matchIndex < matches.length; matchIndex++) {
		const match = matches[matchIndex];
		if (match.page !== pageNumber) { continue; }
		for (const part of match.parts) {
			const span = textLayer.querySelector<HTMLElement>(`span[data-text-index="${part.itemIndex}"]`);
			if (!span) { continue; }
			for (const rect of matchRects(pageNumber, part, span)) {
				const mark = document.createElement("div");
				mark.className = `match-highlight${matchIndex === currentMatch ? " current" : ""}`;
				mark.style.left = `${rect.left - pageRect.left}px`;
				mark.style.top = `${rect.top - pageRect.top}px`;
				mark.style.width = `${rect.width}px`;
				mark.style.height = `${rect.height}px`;
				mark.setAttribute("aria-hidden", "true");
				highlightLayer.append(mark);
			}
		}
	}
}

async function renderPage(pageNumber: number): Promise<void> {
	if (!pdf || renderedPages.has(pageNumber)) { return; }
	const existingToken = renderTokens.get(pageNumber);
	if (existingToken) { return; }
	const token = {};
	renderTokens.set(pageNumber, token);
	const pageElement = pageElements.get(pageNumber);
	if (!pageElement) { renderTokens.delete(pageNumber); return; }
	try {
		const page = await pdf.getPage(pageNumber);
		if (renderTokens.get(pageNumber) !== token) { return; }
		const cachedTextContent = textContents.get(pageNumber);
		const baseViewport = page.getViewport({ scale: 1 });
		pageSizes.set(pageNumber, { width: baseViewport.width, height: baseViewport.height });
		const scale = getPageScale(pageNumber);
		const viewport = page.getViewport({ scale });
		pageElement.style.width = `${Math.round(viewport.width)}px`;
		pageElement.style.height = `${Math.round(viewport.height)}px`;
		// PDF.js sizes text-layer spans with calc(var(--scale-factor) * …); without it every span
		// falls back to the inherited font size and search highlights land in the wrong place.
		pageElement.style.setProperty("--scale-factor", String(viewport.scale));
		pageElement.replaceChildren();
		const canvas = document.createElement("canvas");
		const outputScale = window.devicePixelRatio || 1;
		canvas.width = Math.floor(viewport.width * outputScale);
		canvas.height = Math.floor(viewport.height * outputScale);
		canvas.style.width = `${viewport.width}px`;
		canvas.style.height = `${viewport.height}px`;
		pageElement.append(canvas);
		const textLayer = document.createElement("div");
		textLayer.className = "textLayer";
		textLayer.style.width = `${viewport.width}px`;
		textLayer.style.height = `${viewport.height}px`;
		const highlightLayer = document.createElement("div");
		highlightLayer.className = "highlights";
		pageElement.append(highlightLayer, textLayer);
		const context = canvas.getContext("2d", { alpha: false });
		if (!context) { throw new Error("Canvas is unavailable"); }
		const task = page.render({ canvasContext: context, viewport, transform: outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0] });
		renderTasks.set(pageNumber, task);
		await task.promise;
		if (renderTokens.get(pageNumber) !== token) { return; }
		// Paint the page before extracting text so the first visible page appears sooner.
		const textContent = cachedTextContent ?? await page.getTextContent();
		if (renderTokens.get(pageNumber) !== token) { return; }
		textContents.set(pageNumber, textContent);
		loadFontWidths(page, textContent);
		const textLayerTask = new pdfjsLib.TextLayer({ textContentSource: textContent, container: textLayer, viewport });
		await textLayerTask.render();
		if (renderTokens.get(pageNumber) !== token) { return; }
		addTextItemIndices(textLayerTask.textDivs, textContent);
		renderedPages.add(pageNumber);
		paintHighlights(pageNumber);
		if (pendingMatchReveal && matches[currentMatch]?.page === pageNumber && revealCurrentMatch()) {
			pendingMatchReveal = false;
		}
		updateStatus();
	} catch (error) {
		if (!(error instanceof Error && error.name === "RenderingCancelledException")) {
			console.error(`[AnyaPDF] Failed to render page ${pageNumber}`, error);
			showError("Couldn't open this PDF — the file may be corrupt or password-protected.", `Page ${pageNumber}: ${describeError(error)}`);
		}
	} finally {
		if (renderTokens.get(pageNumber) === token) {
			renderTokens.delete(pageNumber);
			renderTasks.delete(pageNumber);
		}
	}
}

function rerenderNearbyPages(): void {
	for (const task of renderTasks.values()) {
		task.cancel();
	}
	for (const pageNumber of renderedPages) { pageElements.get(pageNumber)?.replaceChildren(); }
	renderedPages.clear();
	renderTasks.clear();
	renderTokens.clear();
	layoutPages();
	for (const pageNumber of nearbyPages) { void renderPage(pageNumber); }
}

function releasePage(pageNumber: number): void {
	renderTasks.get(pageNumber)?.cancel();
	renderTasks.delete(pageNumber);
	renderTokens.delete(pageNumber);
	renderedPages.delete(pageNumber);
	const element = pageElements.get(pageNumber);
	if (element) {
		// Shrinking the canvas frees its pixel memory right away instead of at garbage collection.
		for (const canvas of element.querySelectorAll("canvas")) { canvas.width = 0; canvas.height = 0; }
		element.replaceChildren(); // The element keeps its size, so the layout does not move.
	}
	const owner = pdf;
	void owner?.getPage(pageNumber).then((page) => { if (pdf === owner) { page.cleanup(); } }, () => undefined);
}

// Keeps memory bounded on long documents: only pages near the ones in view stay drawn.
function releaseDistantPages(): void {
	if (!nearbyPages.size) { return; }
	const first = Math.min(...nearbyPages) - keepRenderedDistance;
	const last = Math.max(...nearbyPages) + keepRenderedDistance;
	for (const pageNumber of new Set([...renderedPages, ...renderTokens.keys()])) {
		if (pageNumber < first || pageNumber > last) { releasePage(pageNumber); }
	}
}

function scrollToPage(pageNumber: number): void {
	if (!pdf) { return; }
	const clamped = Math.max(1, Math.min(pdf.numPages, Math.floor(pageNumber)));
	const element = pageElements.get(clamped);
	if (element) {
		currentPage = clamped;
		pageInput.value = String(clamped);
		const readerTop = reader.getBoundingClientRect().top;
		reader.scrollTo({ top: reader.scrollTop + element.getBoundingClientRect().top - readerTop - pageGap, behavior: "smooth" });
		void renderPage(clamped);
		sendStatus();
	}
}

function revealCurrentMatch(): boolean {
	const match = matches[currentMatch];
	if (!match) { return false; }
	const mark = pageElements.get(match.page)?.querySelector<HTMLElement>(".match-highlight.current");
	if (!mark) { return false; }
	// Scroll only the reader: scrollIntoView would also scroll the document and push the toolbar off-screen.
	const markRect = mark.getBoundingClientRect();
	const readerRect = reader.getBoundingClientRect();
	const top = reader.scrollTop + markRect.top - readerRect.top - (reader.clientHeight - markRect.height) / 2;
	let left = reader.scrollLeft;
	if (markRect.left < readerRect.left || markRect.right > readerRect.left + reader.clientWidth) {
		left += markRect.left - readerRect.left - (reader.clientWidth - markRect.width) / 2;
	}
	reader.scrollTo({ top, left, behavior: "smooth" });
	return true;
}

function moveMatch(direction: number): void {
	if (!matches.length) { return; }
	currentMatch = (currentMatch + direction + matches.length) % matches.length;
	const match = matches[currentMatch];
	matchCount.textContent = `${currentMatch + 1} of ${matches.length}`;
	// Repaint every rendered page so the previous "current" mark is cleared even across pages.
	for (const pageNumber of renderedPages) { paintHighlights(pageNumber); }
	if (revealCurrentMatch()) { pendingMatchReveal = false; return; }
	// Page not rendered yet: scroll to it and reveal the match once renderPage paints it.
	pendingMatchReveal = true;
	scrollToPage(match.page);
}

// The page's text as one lower-case string, so a phrase is found even when the PDF stores it
// in several text items (word by word, or across a line break). Runs of whitespace, and line
// ends, become one space. For each character, `items`/`offsets` record which text item and
// which character in it the character came from (-1 for a space added at a line end).
type PageSearchText = { text: string; items: number[]; offsets: number[] };

function buildPageSearchText(content: TextContent): PageSearchText {
	let text = "";
	const items: number[] = [];
	const offsets: number[] = [];
	const add = (character: string, itemIndex: number, offset: number): void => {
		text += character;
		items.push(itemIndex);
		offsets.push(offset);
	};
	let itemIndex = 0;
	for (const item of content.items) {
		if (!("str" in item)) { continue; }
		const source = item.str;
		// Lower-case the whole item at once (as before) so context-dependent rules, such as the
		// Greek final sigma, match a lower-cased query; fall back per character if lengths differ.
		const lower = source.toLocaleLowerCase();
		const sameLength = lower.length === source.length;
		for (let offset = 0; offset < source.length; offset++) {
			if (/\s/.test(source[offset])) {
				if (text.length && !text.endsWith(" ")) { add(" ", itemIndex, offset); }
				continue;
			}
			const folded = sameLength ? lower[offset] : source[offset].toLocaleLowerCase();
			for (const unit of folded.split("")) { add(unit, itemIndex, offset); }
		}
		if ("hasEOL" in item && item.hasEOL && text.length && !text.endsWith(" ")) { add(" ", -1, -1); }
		itemIndex++;
	}
	return { text, items, offsets };
}

/** The text-item ranges covered by characters [start, end) of the page's search text. */
function matchParts(pageText: PageSearchText, start: number, end: number): SearchPart[] {
	const parts: SearchPart[] = [];
	for (let index = start; index < end; index++) {
		const itemIndex = pageText.items[index];
		if (itemIndex < 0) { continue; }
		const offset = pageText.offsets[index];
		const last = parts[parts.length - 1];
		if (last && last.itemIndex === itemIndex) {
			last.start = Math.min(last.start, offset);
			last.end = Math.max(last.end, offset + 1);
		} else {
			parts.push({ itemIndex, start: offset, end: offset + 1 });
		}
	}
	return parts;
}

async function search(query: string, reveal = true): Promise<void> {
	const generation = ++searchGeneration;
	matches = [];
	currentMatch = -1;
	pendingMatchReveal = false;
	matchCount.textContent = "";
	for (const pageNumber of renderedPages) { paintHighlights(pageNumber); }
	if (!pdf || !query.trim()) { return; }
	matchCount.textContent = "Searching…";
	const needle = query.replace(/\s+/g, " ").toLocaleLowerCase();
	try {
		for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
			if (generation !== searchGeneration) { return; }
			const page = await pdf.getPage(pageNumber);
			const content = textContents.get(pageNumber) ?? await page.getTextContent();
			if (generation !== searchGeneration) { return; }
			textContents.set(pageNumber, content);
			const pageText = buildPageSearchText(content);
			let start = 0;
			while ((start = pageText.text.indexOf(needle, start)) !== -1) {
				const parts = matchParts(pageText, start, start + needle.length);
				if (parts.length) { matches.push({ page: pageNumber, parts }); }
				start += Math.max(1, needle.length);
			}
		}
		if (generation !== searchGeneration) { return; }
		if (!reveal) {
			// After a reload, show the matches without jumping away from where the reader was.
			matchCount.textContent = matches.length ? `${matches.length} match${matches.length === 1 ? "" : "es"}` : "No matches";
			for (const pageNumber of renderedPages) { paintHighlights(pageNumber); }
			return;
		}
		matchCount.textContent = matches.length ? `0 of ${matches.length}` : "No matches";
		if (matches.length) { currentMatch = -1; moveMatch(1); }
	} catch {
		if (generation === searchGeneration) { matchCount.textContent = "Search failed"; }
	}
}

async function buildOutline(): Promise<void> {
	if (!pdf) { return; }
	const generation = documentGeneration;
	const outline = await pdf.getOutline();
	if (generation !== documentGeneration) { return; } // A reloaded document replaced this one.
	if (!outline?.length) { outlinePane.hidden = true; return; }
	outlineToggle.hidden = false;
	const createItems = (items: typeof outline): HTMLUListElement => {
		const list = document.createElement("ul");
		for (const item of items) {
			const row = document.createElement("li");
			const button = document.createElement("button");
			button.textContent = item.title || "Untitled";
			button.title = item.title || "";
			button.addEventListener("click", async () => {
				try {
					const destination = typeof item.dest === "string" ? await pdf?.getDestination(item.dest) : item.dest;
					if (destination && pdf) { scrollToPage((await pdf.getPageIndex(destination[0])) + 1); }
				} catch { /* Ignore outline entries with invalid destinations. */ }
			});
			row.append(button);
			if (item.items?.length) { row.append(createItems(item.items)); }
			list.append(row);
		}
		return list;
	};
	outlineList.append(createItems(outline));
}

function setZoom(nextZoom: number): void {
	fitWidth = false;
	zoom = Math.max(25, Math.min(400, nextZoom));
	rerenderNearbyPages();
}

function attachControls(): void {
	byId("prev-page").addEventListener("click", () => scrollToPage(currentPage - 1));
	byId("next-page").addEventListener("click", () => scrollToPage(currentPage + 1));
	pageInput.addEventListener("change", () => scrollToPage(Number(pageInput.value) || 1));
	byId("zoom-in").addEventListener("click", () => setZoom(zoom + 25));
	byId("zoom-out").addEventListener("click", () => setZoom(zoom - 25));
	byId("zoom-reset").addEventListener("click", () => setZoom(100));
	fitWidthButton.addEventListener("click", () => { fitWidth = !fitWidth; rerenderNearbyPages(); });
	byId("prev-match").addEventListener("click", () => moveMatch(-1));
	byId("next-match").addEventListener("click", () => moveMatch(1));
	searchInput.addEventListener("input", () => {
		const query = searchInput.value;
		window.clearTimeout(searchTimer);
		searchTimer = window.setTimeout(() => { void search(query); }, 250);
	});
	searchInput.addEventListener("keydown", (event) => {
		if (event.key === "Enter") { event.preventDefault(); moveMatch(event.shiftKey ? -1 : 1); }
		if (event.key === "Escape") {
			searchInput.value = "";
			void search("");
			searchInput.blur();
		}
	});
	outlineToggle.addEventListener("click", () => { outlinePane.hidden = !outlinePane.hidden; });
	reader.addEventListener("scroll", () => updateStatus(), { passive: true });
	window.addEventListener("resize", () => {
		if (fitWidth) { rerenderNearbyPages(); }
	});
}

let searchTimer = 0;

// Asks the extension for the PDF's password (VS Code shows a password input box).
function requestPassword(incorrect: boolean): Promise<string | undefined> {
	passwordRequest?.(undefined);
	return new Promise((resolve) => {
		passwordRequest = resolve;
		vscode.postMessage({ type: "requestPassword", incorrect });
	});
}

async function loadDocument(data: Uint8Array): Promise<pdfjsLib.PDFDocumentProxy> {
	// fontExtraProperties exposes glyph widths, used to place search highlights precisely.
	// No password is passed or kept: PDF.js asks through onPassword each time it needs one.
	const loadingTask = pdfjsLib.getDocument({ data, isEvalSupported: false, fontExtraProperties: true });
	let cancelled = false;
	loadingTask.onPassword = (updatePassword: (password: string) => void, reason: number) => {
		void requestPassword(reason === pdfjsLib.PasswordResponses.INCORRECT_PASSWORD).then((value) => {
			if (value === undefined) {
				cancelled = true;
				void loadingTask.destroy();
			} else {
				updatePassword(value);
			}
		});
	};
	try {
		return await loadingTask.promise;
	} catch (error) {
		if (cancelled) { throw new PasswordCancelledError("No password was entered."); }
		throw error;
	}
}

// Clears everything that belongs to the current document so another one can be shown.
function resetViewer(): void {
	documentGeneration++;
	searchGeneration++;
	observer?.disconnect();
	observer = undefined;
	for (const task of renderTasks.values()) { task.cancel(); }
	for (const element of pageElements.values()) {
		for (const canvas of element.querySelectorAll("canvas")) { canvas.width = 0; canvas.height = 0; }
	}
	renderTasks.clear();
	renderTokens.clear();
	renderedPages.clear();
	nearbyPages.clear();
	pageElements.clear();
	pageSizes.clear();
	textContents.clear();
	textItemsByPage.clear();
	fontWidths.clear();
	pagesElement.replaceChildren();
	outlineList.replaceChildren();
	outlineToggle.hidden = true;
	matches = [];
	currentMatch = -1;
	pendingMatchReveal = false;
	matchCount.textContent = "";
	errorMessage.hidden = true;
}

async function showDocument(nextPdf: pdfjsLib.PDFDocumentProxy, position?: ViewPosition): Promise<void> {
	const firstPage = await nextPdf.getPage(1);
	const firstViewport = firstPage.getViewport({ scale: 1 });
	const previous = pdf;
	resetViewer();
	pdf = nextPdf;
	pageTotal.textContent = `/ ${pdf.numPages}`;
	for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) { makePageElement(pageNumber); }
	pageSizes.set(1, { width: firstViewport.width, height: firstViewport.height });
	// Seed approximate page geometry, then replace it with exact dimensions as pages enter view.
	layoutPages();
	if (position) { restoreViewPosition(position); }
	const currentObserver = new IntersectionObserver((entries) => {
		for (const entry of entries) {
			const pageNumber = Number((entry.target as HTMLElement).dataset.page);
			if (entry.isIntersecting) {
				nearbyPages.add(pageNumber);
				void renderPage(pageNumber);
			} else {
				nearbyPages.delete(pageNumber);
			}
		}
		releaseDistantPages();
		updateStatus();
	}, { root: reader, rootMargin: "250px 0px", threshold: 0 });
	observer = currentObserver;
	for (const element of pageElements.values()) { currentObserver.observe(element); }
	void renderPage(position ? currentPage : 1).finally(() => { void buildOutline(); });
	updateStatus();
	if (previous && previous !== nextPdf) { void previous.destroy(); }
}

async function openPdf(data: Uint8Array, defaultZoom: number, fitToWidthOnOpen: boolean): Promise<void> {
	let phase = "starting the PDF worker";
	try {
		await initializePdfWorker();
		phase = "loading the document";
		const loaded = await loadDocument(data);
		const settings = vscode.getState() as SavedState | undefined;
		zoom = settings?.zoom ?? defaultZoom;
		fitWidth = settings?.fitWidth ?? fitToWidthOnOpen;
		const position = typeof settings?.page === "number"
			? { page: settings.page, pageOffset: settings.pageOffset ?? 0, scrollLeft: settings.scrollLeft ?? 0 }
			: undefined;
		phase = "reading the first page";
		await showDocument(loaded, position);
	} catch (error) {
		if (error instanceof PasswordCancelledError) {
			showError("This PDF is password-protected. Close and reopen it to enter the password.");
			return;
		}
		console.error(`[AnyaPDF] Failed while ${phase}`, error);
		showError("Couldn't open this PDF — the file may be corrupt or password-protected.", `${phase}: ${describeError(error)}`);
	}
}

// The file changed on disk: show the new version at the same page, zoom and scroll position.
// If it cannot be opened, the previous version stays on screen.
async function reloadPdf(data: Uint8Array): Promise<void> {
	if (!pdf) {
		await openPdf(data, openSettings.defaultZoom, openSettings.fitToWidthOnOpen);
		return;
	}
	const generation = ++reloadGeneration;
	try {
		const loaded = await loadDocument(data);
		if (generation !== reloadGeneration) { void loaded.destroy(); return; }
		const query = searchInput.value;
		await showDocument(loaded, getViewPosition());
		if (query.trim()) { void search(query, false); }
	} catch (error) {
		if (generation !== reloadGeneration) { return; }
		if (error instanceof PasswordCancelledError) {
			showError("The updated PDF is password-protected. Close and reopen it to enter the password.");
			return;
		}
		console.error("[AnyaPDF] Failed to reload the changed PDF", error);
		showError("Couldn't reload this PDF after it changed on disk. The previous version is still shown.", describeError(error));
	}
}

window.addEventListener("message", (event: MessageEvent) => {
	const message = event.data as { type?: string; data?: ArrayBuffer; action?: string; page?: number; defaultZoom?: number; fitToWidthOnOpen?: boolean; password?: unknown };
	if (message.type === "loadPdf") {
		if (!(message.data instanceof ArrayBuffer)) {
			showError("AnyaPDF couldn't receive this PDF.", "The extension sent data in an unsupported format.");
			return;
		}
		openSettings = { defaultZoom: message.defaultZoom ?? 100, fitToWidthOnOpen: message.fitToWidthOnOpen ?? false };
		void openPdf(new Uint8Array(message.data), openSettings.defaultZoom, openSettings.fitToWidthOnOpen);
	}
	if (message.type === "reloadPdf" && message.data instanceof ArrayBuffer) {
		void reloadPdf(new Uint8Array(message.data));
	}
	if (message.type === "password") {
		const resolve = passwordRequest;
		passwordRequest = undefined;
		resolve?.(typeof message.password === "string" ? message.password : undefined);
	}
	if (message.type === "requestStatus") { updateStatus(true); }
	if (message.type === "action") {
		switch (message.action) {
			case "zoomIn": setZoom(zoom + 25); break;
			case "zoomOut": setZoom(zoom - 25); break;
			case "zoomReset": setZoom(100); break;
			case "fitWidth": fitWidth = !fitWidth; rerenderNearbyPages(); break;
			case "find": searchInput.focus(); searchInput.select(); break;
			case "nextPage": scrollToPage(currentPage + 1); break;
			case "prevPage": scrollToPage(currentPage - 1); break;
			case "goToPage": if (message.page) { scrollToPage(message.page); } break;
		}
	}
});

window.addEventListener("beforeunload", () => {
	saveState();
	for (const task of renderTasks.values()) { task.cancel(); }
	if (workerUrl) { URL.revokeObjectURL(workerUrl); }
});

attachControls();
vscode.postMessage({ type: "ready" });
