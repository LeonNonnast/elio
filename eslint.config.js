// ───────────────────────────── ESLint flat config (Quality-Tick, §9) ─────────────────────────────
// @eslint/js + typescript-eslint RECOMMENDED (NICHT type-checked/strict — schnell + low-noise). Zielt
// auf packages/*/src/**/*.ts; dist/node_modules sind ignoriert. Das harte Typ-Gate bleibt `tsc -b`
// (strict, noUncheckedIndexedAccess, exactOptionalPropertyTypes); eslint fängt nur leichte Lints ab.

import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // Nur Paket-Quellen linten; Build-Artefakte + Deps + Configs außen vor.
    ignores: ["**/dist/**", "**/node_modules/**", "**/*.config.js", "**/*.config.ts"],
  },
  {
    files: ["packages/*/src/**/*.ts"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    rules: {
      // Bewusst entschärft (über-pedantisch fürs v0.1-Skelett; lieber Regel hier deaktivieren als
      // funktionierenden Code stilistisch umschreiben):
      // - Leere Funktionen/Catch sind in Stubs/Seams legitim.
      "no-empty": ["error", { allowEmptyCatch: true }],
      "@typescript-eslint/no-empty-function": "off",
      // - Bewusste `void x;`-Markierungen + `as unknown as T`-Registry-Casts sind im Code dokumentiert.
      "@typescript-eslint/no-unused-expressions": "off",
      // - Underscore-präfixierte Args/Vars sind absichtlich ungenutzt (Signatur-Konformität).
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
      // - `const self = this` ist im Child-Branch-Executor bewusst (capture für die Methoden des
      //   zurückgegebenen Objekt-Literals); kein Stil-Rewrite working code.
      "@typescript-eslint/no-this-alias": "off",
    },
  },
  {
    // Tests dürfen etwas lockerer sein (z.B. `!`-Assertions auf bekannten Test-Daten).
    files: ["packages/*/src/**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
);
