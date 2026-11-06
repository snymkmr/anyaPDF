const path = require("path");
const CopyPlugin = require("copy-webpack-plugin");

module.exports = [
  {
    name: "extension",
    mode: "development",
    target: "node",
    entry: "./src/extension.ts",
    output: {
      path: path.resolve(__dirname, "out"),
      filename: "extension.js",
      libraryTarget: "commonjs2",
      devtoolModuleFilenameTemplate: "../[resource-path]"
    },
    devtool: "source-map",
    externals: { vscode: "commonjs vscode" },
    resolve: { extensions: [".ts", ".js"] },
    module: {
      rules: [{ test: /\.ts$/, exclude: /node_modules/, use: "ts-loader" }]
    },
    plugins: [
      new CopyPlugin({
        patterns: [
          {
            from: path.resolve(__dirname, "node_modules/pdfjs-dist/build/pdf.worker.min.mjs"),
            to: path.resolve(__dirname, "out/media/pdf.worker.min.mjs"),
            transform(content) {
              // Keep the PDF.js 4 worker compatible with the Chromium bundled in VS Code 1.85.
              const promiseCompat = `if (typeof Promise.withResolvers !== "function") { Promise.withResolvers = function () { var resolve, reject; var promise = new Promise(function (res, rej) { resolve = res; reject = rej; }); return { promise: promise, resolve: resolve, reject: reject }; }; }`;
              const modificationNotice = "// Modified by AnyaPDF: Promise.withResolvers shim prepended. The original PDF.js worker follows unchanged. See THIRD-PARTY-NOTICES.md.";
              return `${modificationNotice}\n${promiseCompat}\n${content.toString()}`;
            }
          }
        ]
      })
    ]
  },
  {
    name: "webview",
    mode: "production",
    target: "web",
    entry: "./src/webview/viewer.ts",
    output: {
      path: path.resolve(__dirname, "out/media"),
      filename: "viewer.js",
      clean: false
    },
    devtool: false,
    resolve: { extensions: [".ts", ".js", ".mjs"] },
    module: {
      rules: [{ test: /\.ts$/, exclude: /node_modules/, use: "ts-loader" }]
    }
  }
];
