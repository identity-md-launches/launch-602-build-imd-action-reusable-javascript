// Bundles the tsc output (build/src) and the @noble libraries into one
// self-contained ES module, dist/index.js, which GitHub runs with node20.
import { fileURLToPath } from 'node:url';

/** Resolve bare package imports with Node's own ESM resolution. */
const nodeResolve = {
  name: 'node-resolve',
  resolveId(id, importer) {
    if (!importer || id.startsWith('node:') || id.startsWith('.') || id.startsWith('/')) return null;
    return fileURLToPath(import.meta.resolve(id));
  },
};

export default {
  input: 'build/src/main.js',
  output: { file: 'dist/index.js', format: 'es', generatedCode: 'es2015' },
  external: [/^node:/],
  plugins: [nodeResolve],
};
