import { defineConfig } from "vite-plus"

// Agent tooling and the vendored anti-slop plugin are not application source.
const agentAssets = [
  ".agent/**",
  ".agents/**",
  ".claude/**",
  ".codex/**",
  ".continue/**",
  ".cursor/**",
  ".gemini/**",
  ".opencode/**",
  ".pi/**",
  ".roo/**",
  ".windsurf/**",
  "tools/oxlint/anti-slop/**",
]

export default defineConfig({
  fmt: {
    printWidth: 80,
    semi: false,
    ignorePatterns: agentAssets,
  },
  lint: {
    plugins: ["typescript", "import"],
    jsPlugins: [
      { name: "vite-plus", specifier: "vite-plus/oxlint-plugin" },
      { name: "anti-slop", specifier: "./tools/oxlint/anti-slop/index.ts" },
      {
        name: "anti-slop-effect",
        specifier: "./tools/oxlint/anti-slop/effect/index.ts",
      },
    ],
    rules: {
      "vite-plus/prefer-vite-plus-imports": "error",
      "oxc/no-accumulating-spread": "warn",
      "anti-slop/no-array-filter-map": "warn",
      "anti-slop/no-reduce-accumulator-copy": "warn",
      "anti-slop/no-chained-type-assertions": "warn",
      "anti-slop/no-conditional-empty-object-spread": "warn",
      "anti-slop/no-known-value-widening": "warn",
      "anti-slop/no-module-mocking": "warn",
      "anti-slop/no-object-parameters": "warn",
      "anti-slop/no-reflect-apply": "warn",
      "anti-slop/no-reflect-get": "warn",
      "anti-slop/no-runtime-typeof": "warn",
      "anti-slop/no-shape-in-symbol-names": "warn",
      "anti-slop/no-unknown-parameters": "warn",
      "anti-slop/no-unknown-returns": "warn",
      "anti-slop/no-unknown-type-aliases": "warn",
      "anti-slop/no-unsafe-dictionary-type": "warn",
      "anti-slop/no-widen-then-assert": "warn",
      "anti-slop/require-readable-spacing": "warn",
      "anti-slop/require-safety-comment-for-type-assertion": "warn",
      "anti-slop-effect/no-manual-effect-error-tag": "warn",
      "anti-slop-effect/no-manual-tag-comparison": "warn",
      "anti-slop-effect/no-manual-tagged-construction": "warn",
      "anti-slop-effect/no-service-constructor-imports": "warn",
      "anti-slop-effect/prefer-effect-match": "warn",
    },
    options: { typeAware: true, typeCheck: true },
    ignorePatterns: [".repos", ".direnv", "dist", ...agentAssets],
  },
  test: {
    // Anchor discovery on each package's test/ directory (this config is
    // inherited when `vp test` runs inside a package); `.repos/` holds whole
    // reference monorepos whose own suites must never be collected.
    include: ["**/test/**/*.test.ts"],
    exclude: [".repos/**", "**/node_modules/**", "**/dist/**"],
  },
  run: {
    cache: true,
  },
})
