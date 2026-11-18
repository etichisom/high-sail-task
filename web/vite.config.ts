// The web app. `npm run dev` here serves it on :5173 and passes API calls to the API on :3000.
// `npm run build` writes web/dist, which the API serves itself at http://localhost:3000.
import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const api = "http://localhost:3000";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "./src") } },
  server: {
    proxy: Object.fromEntries(
      ["/auth", "/me", "/documents", "/ask", "/conversations", "/evals", "/health"].map((p) => [p, api]),
    ),
  },
});
