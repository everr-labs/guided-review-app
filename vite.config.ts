import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
	plugins: [react(), tailwindcss()],
	clearScreen: false,
	resolve: {
		alias: {
			"@": path.resolve(__dirname, "./src"),
		},
		extensions: [".tsx", ".ts", ".mjs", ".js", ".mts", ".jsx", ".json"],
	},
	server: {
		port: 1420,
		strictPort: true,
		host: host || false,
		hmr: host
			? { protocol: "ws", host, port: 1421 }
			: undefined,
		watch: { ignored: ["**/src-tauri/**"] },
	},
});
