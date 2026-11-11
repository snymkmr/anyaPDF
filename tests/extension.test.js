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
  const watchers = [];
  const inputBoxes = [];
  const inputBoxAnswers = [];

  class EventEmitter {
    constructor() { this.listeners = []; }
    get event() { return (listener) => { this.listeners.push(listener); return { dispose() {} }; }; }
    fire(value) { this.listeners.forEach((listener) => listener(value)); }
    dispose() { this.listeners = []; }
  }

  const uri = (fsPath) => ({ fsPath, path: fsPath, toString: () => fsPath });

  class RelativePattern {
    constructor(base, pattern) { this.base = base; this.pattern = pattern; }
  }

  return {
    registeredCommands,
    customEditors,
    configuration,
    watchers,
    inputBoxes,
    inputBoxAnswers,
    vscode: {
      EventEmitter,
      RelativePattern,
      StatusBarAlignment: { Left: 1, Right: 2 },
      Uri: { file: uri, joinPath: (base, ...parts) => uri(path.join(base.fsPath, ...parts)) },
      commands: {
        registerCommand(id, callback) { registeredCommands.set(id, callback); return { dispose() {} }; }
      },
      window: {
        createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {}, text: '', name: '' }),
        registerCustomEditorProvider(viewType, provider) { customEditors.set(viewType, provider); return { dispose() {} }; },
        showErrorMessage() {},
        showInputBox: async (options) => { inputBoxes.push(options); return inputBoxAnswers.shift(); }
      },
      workspace: {
        getConfiguration: () => ({ get: (key, fallback) => (key in configuration ? configuration[key] : fallback) }),
        createFileSystemWatcher(pattern, ignoreCreate, ignoreChange, ignoreDelete) {
          const watcher = { pattern, ignoreCreate, ignoreChange, ignoreDelete, change: [], create: [], disposed: false,
            onDidChange(listener) { watcher.change.push(listener); return { dispose() {} }; },
            onDidCreate(listener) { watcher.create.push(listener); return { dispose() {} }; },
            dispose() { watcher.disposed = true; } };
          watchers.push(watcher);
          return watcher;
        },
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

test('recognises complete PDFs by their %%EOF marker', () => {
  const { extension } = loadExtension();
  assert.equal(extension.isCompletePdf(Buffer.from('%PDF-1.4\n1 0 obj\n%%EOF\n')), true);
  assert.equal(extension.isCompletePdf(Buffer.from('%PDF-1.4\n1 0 obj\n<< /Len')), false);
  assert.equal(extension.isCompletePdf(new Uint8Array()), false);
});

test('reloads open viewers when the PDF changes on disk, skipping partial and unchanged writes', async (t) => {
  const { customEditors, watchers } = loadExtension();
  const provider = customEditors.get('anyapdf.pdfViewer');
  const directory = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'anyapdf-watch-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'paper.pdf');
  fs.writeFileSync(file, '%PDF-1.4 first\n%%EOF\n');
  const uri = { fsPath: file, path: file, scheme: 'file', toString: () => file };

  const document = await provider.openCustomDocument(uri);
  assert.equal(watchers.length, 1);
  assert.equal(watchers[0].pattern.pattern, 'paper.pdf');
  assert.equal(watchers[0].pattern.base.fsPath, directory);
  assert.equal(watchers[0].ignoreDelete, true);
  const { panel, posted, send } = createPanel();
  await provider.resolveCustomEditor(document, panel);
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const reloads = () => posted.filter((message) => message.type === 'reloadPdf');

  fs.writeFileSync(file, '%PDF-1.4 second, still being writ');
  watchers[0].change.forEach((listener) => listener());
  await wait(650);
  assert.equal(reloads().length, 0, 'a partly written PDF is not loaded');

  fs.writeFileSync(file, '%PDF-1.4 second\n%%EOF\n');
  watchers[0].change.forEach((listener) => listener());
  watchers[0].change.forEach((listener) => listener());
  await wait(650);
  assert.equal(reloads().length, 1, 'rapid change events are combined into one reload');
  assert.equal(Buffer.from(reloads()[0].data).toString(), '%PDF-1.4 second\n%%EOF\n');

  watchers[0].create.forEach((listener) => listener());
  await wait(650);
  assert.equal(reloads().length, 1, 'unchanged content is not reloaded');

  send({ type: 'ready' });
  const loaded = posted.filter((message) => message.type === 'loadPdf').pop();
  assert.equal(Buffer.from(loaded.data).toString(), '%PDF-1.4 second\n%%EOF\n', 'a reopened viewer gets the latest bytes');

  document.dispose();
  assert.equal(watchers[0].disposed, true);
});

test('asks for a password with a password box and remembers it only for the open document', async () => {
  const { customEditors, inputBoxes, inputBoxAnswers } = loadExtension();
  const provider = customEditors.get('anyapdf.pdfViewer');
  const { panel, posted, send } = createPanel();
  const document = { uri: { fsPath: '/tmp/locked.pdf' }, bytes: new Uint8Array([37, 80, 68, 70]) };
  await provider.resolveCustomEditor(document, panel);
  const wait = () => new Promise((resolve) => setImmediate(resolve));

  inputBoxAnswers.push('wrong', 'secret');
  send({ type: 'requestPassword', incorrect: false });
  await wait();
  send({ type: 'requestPassword', incorrect: true });
  await wait();
  assert.equal(inputBoxes.length, 2);
  assert.equal(inputBoxes[0].password, true);
  assert.match(inputBoxes[0].prompt, /password-protected/);
  assert.match(inputBoxes[1].prompt, /Incorrect password/);
  assert.deepEqual(posted.filter((message) => message.type === 'password').map((message) => message.password), ['wrong', 'secret']);

  send({ type: 'ready' });
  assert.equal(posted.filter((message) => message.type === 'loadPdf').pop().password, 'secret');

  send({ type: 'requestPassword', incorrect: true });
  await wait();
  assert.equal(posted.filter((message) => message.type === 'password').pop().password, undefined, 'cancelling sends no password');
});
