import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In development, the console runs on Vite and forwards API calls to a local control service.
const control = process.env.CONTROL_URL ?? "http://localhost:8790";
const proxied = ["/v1", "/auth", "/setup", "/w"];

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: "/",
  build: { outDir: "dist", emptyOutDir: true },
  server: { proxy: Object.fromEntries(proxied.map((path) => [path, { target: control, changeOrigin: true }])) },
});
