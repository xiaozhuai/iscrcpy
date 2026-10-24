const fs = require('node:fs')
const ts = require('typescript')

// Use the project's existing compiler; tests need no additional runner dependency.
require.extensions['.ts'] = (module, filename) => {
  const result = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  })
  module._compile(result.outputText, filename)
}
