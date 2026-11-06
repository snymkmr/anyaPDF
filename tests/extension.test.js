const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const { test } = require('node:test');

const root = path.resolve(__dirname, '..');
const manifest = require('../package.json');

function createVscodeStub() {
  const registeredCommands = new Map();
  const customEditors = new Map();
  const configuration = {};

  class EventEmitter {
    constructor() { this.listeners = []; }
    get event() { return (listener) => { this.listeners.push(listener); return { dispose() {} }; }; }
    fire(value) { this.listeners.forEach((listener) => listener(value)); }
    dispose() { this.listeners = []; }
  }

  const uri = (fsPath) => ({ fsPath, path: fsPath, toString: () => fsPath });

  return {
    registeredCommands,
    customEditors,
    configuration,
    vscode: {
      EventEmitter,
      StatusBarAlignment: { Left: 1, Right: 2 },
      Uri: { file: uri, joinPath: (base, ...parts) => uri(path.join(base.fsPath, ...parts)) },
      commands: {
        registerCommand(id, callback) { registeredCommands.set(id, callback); return { dispose() {} }; }
      },
      window: {
        createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {}, text: '', name: '' }),
        registerCustomEditorProvider(viewType, provider) { customEditors.set(viewType, provider); return { dispose() {} }; },
        showErrorMessage() {},
        showInputBox: async () => undefined
      },
      workspace: {
        getConfiguration: () => ({ get: (key, fallback) => (key in configuration ? configuration[key] : fallback) }),
        fs: { readFile: async (target) => new Uint8Array(fs.readFileSync(target.fsPath)) }
      }
    }
  };
}

function loadExtension() {
  const stub = createVscodeStub();
  const originalLoad = Module._load;
  const modulePath = require.resolve('../out/extension');
  delete require.cache[modulePath];
  try {
    Module._load = function load(request, parent, isMain) {
      if (request === 'vscode') return stub.vscode;
      return originalLoad.call(this, request, parent, isMain);
    };
    const extension = require(modulePath);
    const context = { extensionUri: stub.vscode.Uri.file(root), subscriptions: [] };
    extension.activate(context);
    return { ...stub, extension, context };
  } finally {
    Module._load = originalLoad;
  }
}

function createPanel() {
  const posted = [];
  let onMessage;
  const panel = {
    active: true,
    title: '',
    webview: {
      options: {},
      html: '',
      cspSource: 'https://csp.invalid',
      asWebviewUri: (target) => ({ toString: () => `vscode-webview://test${target.fsPath}`, fsPath: target.fsPath }),
      postMessage: async (message) => { posted.push(message); return true; },
      onDidReceiveMessage: (listener) => { onMessage = listener; return { dispose() {} }; }
    },
    onDidChangeViewState: () => ({ dispose() {} }),
    onDidDispose: () => ({ dispose() {} })
  };
  return { panel, posted, send: (message) => onMessage(message) };
}

test('registers the AnyaPDF custom editor declared in package.json', () => {
  const { customEditors } = loadExtension();
  const declared = manifest.contributes.customEditors.map((editor) => editor.viewType);
  assert.deepEqual([...customEditors.keys()], declared);
});

test('registers exactly the commands declared in package.json', () => {
  const { registeredCommands } = loadExtension();
  const declared = manifest.contributes.commands.map((command) => command.command).sort();
  assert.deepEqual([...registeredCommands.keys()].sort(), declared);
});

test('keybindings only reference declared commands', () => {
  const declared = new Set(manifest.contributes.commands.map((command) => command.command));
  for (const binding of manifest.contributes.keybindings) {
    assert.ok(declared.has(binding.command), `${binding.command} is not a declared command`);
  }
});

test('viewer HTML fills every placeholder and points at files that exist', async () => {
  const { customEditors } = loadExtension();
  const provider = customEditors.get('anyapdf.pdfViewer');
  const { panel } = createPanel();
  const document = { uri: { fsPath: path.join(root, 'sample.pdf') }, bytes: new Uint8Array([37, 80, 68, 70]) };

  await provider.resolveCustomEditor(document, panel);

  assert.doesNotMatch(panel.webview.html, /\{\{\w+\}\}/);
  const resources = [...panel.webview.html.matchAll(/vscode-webview:\/\/test([^"]+)/g)].map((match) => match[1]);
  assert.ok(resources.length >= 3, 'expected viewer script, worker, and stylesheet references');
  for (const resource of resources) {
    assert.ok(fs.existsSync(resource), `missing webview resource: ${path.relative(root, resource)}`);
  }
  const roots = panel.webview.options.localResourceRoots.map((uri) => uri.fsPath);
  for (const resource of resources) {
    assert.ok(roots.some((dir) => resource.startsWith(dir + path.sep)), `${resource} is outside localResourceRoots`);
  }
});

test('sends the PDF bytes as an ArrayBuffer with configured defaults when the viewer is ready', async () => {
  const { customEditors, configuration } = loadExtension();
  configuration.defaultZoom = 150;
  configuration.fitToWidthOnOpen = false;
  const provider = customEditors.get('anyapdf.pdfViewer');
  const { panel, posted, send } = createPanel();
  const bytes = new Uint8Array([37, 80, 68, 70, 45, 49]);

  await provider.resolveCustomEditor({ uri: { fsPath: '/tmp/a.pdf' }, bytes }, panel);
  send({ type: 'ready' });

  const message = posted.find((item) => item.type === 'loadPdf');
  assert.ok(message, 'expected a loadPdf message');
  assert.ok(message.data instanceof ArrayBuffer);
  assert.deepEqual([...new Uint8Array(message.data)], [...bytes]);
  assert.equal(message.defaultZoom, 150);
  assert.equal(message.fitToWidthOnOpen, false);
});

test('third-party notices match the bundled PDF.js version and license', () => {
  const notices = fs.readFileSync(path.join(root, 'THIRD-PARTY-NOTICES.md'), 'utf8');
  const pdfjs = require('pdfjs-dist/package.json');
  assert.match(notices, new RegExp(`Version: ${pdfjs.version.replace(/\./g, '\\.')}\\b`), 'update THIRD-PARTY-NOTICES.md after upgrading pdfjs-dist');
  const licenseText = fs.readFileSync(path.join(root, 'node_modules/pdfjs-dist/LICENSE'), 'utf8').trim();
  assert.ok(notices.includes(licenseText), 'THIRD-PARTY-NOTICES.md must contain the full PDF.js license');
});
