/**
 * Lets `node --experimental-strip-types` run the app's TypeScript directly.
 *
 * The repo uses bundler-style imports ("./normalize", "@/lib/...") which Node's
 * ESM resolver rejects, and no bundler is installed. This hook fills exactly
 * that gap — extensionless relative specifiers and the `@/` alias — using only
 * node:module. Dev tooling for one-off scripts; nothing ships with it.
 *
 *   node --experimental-strip-types --import ./scripts/ts-loader.mjs script.ts
 */
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const SRC = path.resolve(import.meta.dirname, '..', 'src');

function firstExisting(base) {
  for (const candidate of [`${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    let base = null;

    if (specifier.startsWith('@/')) {
      base = path.join(SRC, specifier.slice(2));
    } else if (specifier.startsWith('.') && !path.extname(specifier)) {
      const parent = context.parentURL
        ? path.dirname(fileURLToPath(context.parentURL))
        : process.cwd();
      base = path.resolve(parent, specifier);
    }

    if (base) {
      const resolved = firstExisting(base);
      if (resolved) {
        // No explicit `format`: Node infers TypeScript from the .ts extension
        // and applies type stripping. Forcing 'module' would skip that.
        return { url: pathToFileURL(resolved).href, shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  },
});
