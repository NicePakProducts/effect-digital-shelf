import { defineConfig } from "vite-plus"

export default defineConfig({
  fmt: {
    printWidth: 80,
    semi: false,
  },
  lint: {
    plugins: ["typescript", "import"],
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: {
      "vite-plus/prefer-vite-plus-imports": "error",
    },
    options: { typeAware: true, typeCheck: true },
    ignorePatterns: [".repos", ".direnv", "dist"],
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
