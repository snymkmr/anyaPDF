import "./promise-compat";
import * as pdfjsLib from "pdfjs-dist";

type SearchMatch = { page: number; itemIndex: number; start: number; end: number };
type TextItemLike = { str: string };
type TextContent = Awaited<ReturnType<pdfjsLib.PDFPageProxy["getTextContent"]>>;

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
let lastStatus = "";
const pageElements = new Map<number, HTMLDivElement>();
const pageSizes = new Map<number, { width: number; height: number }>();
const textContents = new Map<number, TextContent>();
const renderedPages = new Set<number>();
const nearbyPages = new Set<number>();
const renderTasks = new Map<number, pdfjsLib.RenderTask>();
const renderTokens = new Map<number, object>();

async function initializePdfWorker(): Promise<void> {
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
		const span = textLayer.querySelector<HTMLElement>(`span[data-text-index="${match.itemIndex}"]`);
		if (!span) { continue; }
		const range = makeRange(span, match.start, match.end);
		if (!range) { continue; }
		for (const rect of Array.from(range.getClientRects())) {
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
		const textLayerTask = new pdfjsLib.TextLayer({ textContentSource: textContent, container: textLayer, viewport });
		await textLayerTask.render();
		if (renderTokens.get(pageNumber) !== token) { return; }
		addTextItemIndices(textLayerTask.textDivs, textContent);
		renderedPages.add(pageNumber);
		paintHighlights(pageNumber);
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

function scrollToPage(pageNumber: number): void {
	if (!pdf) { return; }
	const clamped = Math.max(1, Math.min(pdf.numPages, Math.floor(pageNumber)));
	const element = pageElements.get(clamped);
	if (element) {
		currentPage = clamped;
		pageInput.value = String(clamped);
		element.scrollIntoView({ behavior: "smooth", block: "start" });
		void renderPage(clamped);
		sendStatus();
	}
}

function moveMatch(direction: number): void {
	if (!matches.length) { return; }
	currentMatch = (currentMatch + direction + matches.length) % matches.length;
	const match = matches[currentMatch];
	matchCount.textContent = `${currentMatch + 1} of ${matches.length}`;
	scrollToPage(match.page);
	void renderPage(match.page).then(() => paintHighlights(match.page));
}

async function search(query: string): Promise<void> {
	const generation = ++searchGeneration;
	matches = [];
	currentMatch = -1;
	matchCount.textContent = "";
	for (const pageNumber of renderedPages) { paintHighlights(pageNumber); }
	if (!pdf || !query.trim()) { return; }
	matchCount.textContent = "Searching…";
	const needle = query.toLocaleLowerCase();
	try {
		for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
			if (generation !== searchGeneration) { return; }
			const page = await pdf.getPage(pageNumber);
			const content = textContents.get(pageNumber) ?? await page.getTextContent();
			textContents.set(pageNumber, content);
			let itemIndex = 0;
			for (const item of content.items) {
				if (!("str" in item)) { continue; }
				const text = item.str.toLocaleLowerCase();
				let start = 0;
				while ((start = text.indexOf(needle, start)) !== -1) {
					matches.push({ page: pageNumber, itemIndex, start, end: start + needle.length });
					start += Math.max(1, needle.length);
				}
				itemIndex++;
			}
		}
		if (generation !== searchGeneration) { return; }
		matchCount.textContent = matches.length ? `0 of ${matches.length}` : "No matches";
		if (matches.length) { currentMatch = -1; moveMatch(1); }
	} catch {
		if (generation === searchGeneration) { matchCount.textContent = "Search failed"; }
	}
}

async function buildOutline(): Promise<void> {
	if (!pdf) { return; }
	const outline = await pdf.getOutline();
	if (!outline?.length) { return; }
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

async function openPdf(data: Uint8Array, defaultZoom: number, fitToWidthOnOpen: boolean): Promise<void> {
	let phase = "starting the PDF worker";
	try {
		await initializePdfWorker();
		phase = "loading the document";
		const loadingTask = pdfjsLib.getDocument({ data, isEvalSupported: false });
		pdf = await loadingTask.promise;
		pageTotal.textContent = `/ ${pdf.numPages}`;
		for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) { makePageElement(pageNumber); }
		phase = "reading the first page";
		const firstPage = await pdf.getPage(1);
		const firstViewport = firstPage.getViewport({ scale: 1 });
		pageSizes.set(1, { width: firstViewport.width, height: firstViewport.height });
		const settings = vscode.getState() as { zoom?: number; fitWidth?: boolean } | undefined;
		zoom = settings?.zoom ?? defaultZoom;
		fitWidth = settings?.fitWidth ?? fitToWidthOnOpen;
		// Seed approximate page geometry, then replace it with exact dimensions as pages enter view.
		layoutPages();
		const observer = new IntersectionObserver((entries) => {
			for (const entry of entries) {
				const pageNumber = Number((entry.target as HTMLElement).dataset.page);
				if (entry.isIntersecting) {
					nearbyPages.add(pageNumber);
					void renderPage(pageNumber);
				} else {
					nearbyPages.delete(pageNumber);
				}
			}
			updateStatus();
	}, { root: reader, rootMargin: "250px 0px", threshold: 0 });
		for (const element of pageElements.values()) { observer.observe(element); }
		void renderPage(1).finally(() => { void buildOutline(); });
		updateStatus();
	} catch (error) {
		console.error(`[AnyaPDF] Failed while ${phase}`, error);
		showError("Couldn't open this PDF — the file may be corrupt or password-protected.", `${phase}: ${describeError(error)}`);
	}
}

window.addEventListener("message", (event: MessageEvent) => {
	const message = event.data as { type?: string; data?: ArrayBuffer; action?: string; page?: number; defaultZoom?: number; fitToWidthOnOpen?: boolean };
	if (message.type === "loadPdf") {
		if (!(message.data instanceof ArrayBuffer)) {
			showError("AnyaPDF couldn't receive this PDF.", "The extension sent data in an unsupported format.");
			return;
		}
		void openPdf(new Uint8Array(message.data), message.defaultZoom ?? 100, message.fitToWidthOnOpen ?? false);
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
	vscode.setState({ zoom, fitWidth });
	for (const task of renderTasks.values()) { task.cancel(); }
	if (workerUrl) { URL.revokeObjectURL(workerUrl); }
});

attachControls();
vscode.postMessage({ type: "ready" });
