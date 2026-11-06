# AnyaPDF

View PDF documents in Visual Studio Code.

## Features

- Read-only PDF viewer with lazy page rendering
- Text selection, copy, and document search
- Page navigation, zoom, and fit to width
- Document outline navigation when available
- Status bar shows the current page and zoom

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl+=` | Zoom in |
| `Ctrl+-` | Zoom out |
| `Ctrl+0` | Reset zoom |
| `Ctrl+F` | Find in document |
| `PageUp` / `PageDown` | Previous / next page |

## Commands

| Command | Description |
| --- | --- |
| `AnyaPDF: Zoom In` / `Zoom Out` / `Reset Zoom` | Change the zoom level |
| `AnyaPDF: Fit to Width` | Toggle fitting pages to the editor width |
| `AnyaPDF: Go to Page` | Jump to a page number |
| `AnyaPDF: Find` | Focus the find box |
| `AnyaPDF: Next Page` / `Previous Page` | Move between pages |

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `anyapdf.defaultZoom` | `100` | Default zoom percentage (25–400) |
| `anyapdf.fitToWidthOnOpen` | `true` | Fit pages to the editor width when a PDF opens |

AnyaPDF is a read-only viewer. It does not edit, annotate, fill, sign, merge, split, or print PDF files.

## Privacy

See the [Privacy Policy](https://sanyam.dev/privacy) for privacy information about my projects.

License: MIT. AnyaPDF bundles [PDF.js](https://mozilla.github.io/pdf.js/) (Apache License 2.0); see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
