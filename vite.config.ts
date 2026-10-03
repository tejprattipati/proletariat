import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
export default defineConfig({ plugins: [react()], base: process.env.GITHUB_PAGES === "true" ? "/proletariat/" : "/", resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } }, server: { proxy: { "/api": "http://127.0.0.1:3001" } } });
