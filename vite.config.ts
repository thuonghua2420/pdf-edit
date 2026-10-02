import { defineConfig } from "vite";

const apiPort = process.env.PDF_SERVER_PORT || "8787";

export default defineConfig({
  build: {
    chunkSizeWarningLimit: 2200,
  },
  server: {
    proxy: {
      "/api": `http://127.0.0.1:${apiPort}`,
    },
  },
});
