#!/usr/bin/env node
// ───────────────────────────── Post-build ESM extension rewriter ─────────────────────────────
// tsconfig.base.json uses `module: ESNext` + `moduleResolution: Bundler`, so `tsc -b` emits
// relative imports verbatim and EXTENSIONLESS (e.g. `import { x } from "./io"`, `export * from
// "./nodes"`). Node's native ESM loader rejects those (ERR_MODULE_NOT_FOUND for a missing `.js`,
// ERR_UNSUPPORTED_DIR_IMPORT for a directory). The test gate runs against *source* (vitest aliases
// every package to its src), so it never exercises dist — which is why the green gate masked the
// fact that every `bin` (elio / elio-mcp / elio-studio) crashed on launch.
//
// This script makes the emitted ESM genuinely runnable WITHOUT changing the source (the Bundler
// resolution + vitest setup stay untouched) and WITHOUT adding a build dependency: it walks every
// packages/*/dist tree and rewrites RELATIVE static import/export specifiers:
//   "./foo"        -> "./foo.js"            (sibling file foo.js exists)
//   "./bar"        -> "./bar/index.js"      (directory bar/ with index.js exists)
//   "./baz.js"     -> unchanged             (already has an extension)
//   "node:http" / "@elio/core" / "yaml"     -> unchanged (bare specifiers resolve via node_modules)
// Applied to both `.js` (runtime) and `.d.ts` (so downstream typecheck of built decls also resolves).
//
// Conservative by construction: only `./` and `../` specifiers are touched, only when the resolved
// target actually exists on disk; anything ambiguous is left as-is.

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packagesDir = join(repoRoot, "packages");

// Matches `from "<spec>"`, `import "<spec>"`, and `export * from "<spec>"` (single or double quotes).
// Group 1 = leading keyword+quote, Group 2 = specifier, Group 3 = closing quote.
const SPEC_RE = /(\bfrom\s*|\bimport\s*)(["'])((?:\.\.?\/)[^"']*)(\2)/g;

/** Decide the runnable form of a relative specifier resolved against the importing file's dir. */
function rewriteSpecifier(spec, fromFileDir, ext) {
  // Already has a JS/JSON/declaration extension -> leave it.
  if (/\.(m?js|json|d\.ts)$/.test(spec)) return spec;

  const abs = resolve(fromFileDir, spec);

  // Directory import -> point at its index.<ext>.
  if (existsSync(abs) && statSync(abs).isDirectory()) {
    return `${spec}/index${ext}`;
  }
  // Sibling file import -> append the extension if the emitted file exists.
  if (existsSync(`${abs}${ext}`)) {
    return `${spec}${ext}`;
  }
  // Fall back to .js for declaration files that reference a runtime sibling without a .d.ts twin.
  if (ext === ".d.ts" && existsSync(`${abs}.js`)) {
    return `${spec}.js`;
  }
  return spec;
}

function rewriteFile(file) {
  const ext = file.endsWith(".d.ts") ? ".d.ts" : ".js";
  const src = readFileSync(file, "utf8");
  const fromFileDir = dirname(file);
  let changed = false;
  const out = src.replace(SPEC_RE, (whole, kw, q, spec, qe) => {
    const next = rewriteSpecifier(spec, fromFileDir, ext);
    if (next === spec) return whole;
    changed = true;
    return `${kw}${q}${next}${qe}`;
  });
  if (changed) writeFileSync(file, out);
  return changed;
}

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (entry.isFile() && (entry.name.endsWith(".js") || entry.name.endsWith(".d.ts"))) {
      yield full;
    }
  }
}

let filesScanned = 0;
let filesRewritten = 0;
for (const pkg of readdirSync(packagesDir, { withFileTypes: true })) {
  if (!pkg.isDirectory()) continue;
  const dist = join(packagesDir, pkg.name, "dist");
  if (!existsSync(dist)) continue;
  for (const file of walk(dist)) {
    filesScanned += 1;
    if (rewriteFile(file)) filesRewritten += 1;
  }
}

console.log(`fix-esm-extensions: scanned ${filesScanned} dist file(s), rewrote ${filesRewritten}.`);
