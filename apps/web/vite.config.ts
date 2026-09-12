import { defineConfig, loadEnv } from "vite-plus"
import react from "@vitejs/plugin-react"
import { tanstackRouter } from "@tanstack/router-plugin/vite"
import tailwindcss from "@tailwindcss/vite"
import workspaceConfig from "../../vite.config"

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, import.meta.dirname, "WEB_")

  return {
    server: {
      // Alchemy serves the local Worker on 1337 by default; override the
      // target when it prints another port.
      proxy: {
        "/api": {
          target: env.WEB_API_PROXY_TARGET || "http://localhost:1337",
        },
      },
    },
    fmt: {
      ...workspaceConfig.fmt,
      ignorePatterns: ["src/routeTree.gen.ts"],
    },
    lint: {
      ...workspaceConfig.lint,
      ignorePatterns: ["src/routeTree.gen.ts", "dist"],
    },
    test: {
      ...workspaceConfig.test,
      passWithNoTests: true,
    },
    plugins: [
      tailwindcss(),
      tanstackRouter({
        target: "react",
        autoCodeSplitting: true,
        quoteStyle: "double",
        semicolons: false,
      }),
      react(),
    ],
  }
})
