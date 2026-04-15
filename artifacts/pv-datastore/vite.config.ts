import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path, { resolve } from "path";

const port = Number(process.env.PORT ?? "5173");
const basePath = process.env.BASE_PATH ?? "/";

export default defineConfig({
  base: basePath,
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      "@assets": path.resolve(import.meta.dirname, "..", "..", "attached_assets"),
    },
    dedupe: ["react", "react-dom"],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, "index.html"),
        tourism: resolve(import.meta.dirname, "tourism/index.html"),
        "rental-market": resolve(import.meta.dirname, "rental-market/index.html"),
        "pricing-tool": resolve(import.meta.dirname, "pricing-tool/index.html"),
        economic: resolve(import.meta.dirname, "economic/index.html"),
        safety: resolve(import.meta.dirname, "safety/index.html"),
        weather: resolve(import.meta.dirname, "weather/index.html"),
        sources: resolve(import.meta.dirname, "sources/index.html"),
        about: resolve(import.meta.dirname, "about/index.html"),
        contact: resolve(import.meta.dirname, "contact/index.html"),
      },
    },
  },
  server: {
    port,
    host: "0.0.0.0",
    allowedHosts: true,
    fs: {
      strict: true,
      deny: ["**/.*"],
    },
  },
  preview: {
    port,
    host: "0.0.0.0",
    allowedHosts: true,
  },
});
