/// <reference types="vitest" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const testing = Boolean(process.env.VITEST);

// https://vitejs.dev/config/
export default defineConfig({
  // The React plugin's fast-refresh code doesn't run under Vitest; tests use
  // esbuild's JSX transform instead.
  plugins: testing ? [] : [react()],
  esbuild: testing ? { jsx: "automatic" } : undefined,
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    css: false,
    restoreMocks: true,
  },
});
