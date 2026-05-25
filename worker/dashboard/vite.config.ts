import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": "/src",
    },
  },
  // The dashboard talks to the Convex deployment directly. Set VITE_API_URL to
  // the deployment's HTTP actions URL (https://<name>.convex.site) in .env.local.
  build: {
    outDir: "dist",
  },
});
