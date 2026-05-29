import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/auth": "http://localhost:3000",
      "/health": "http://localhost:3000",
      "/journeys": "http://localhost:3000",
      "/history": "http://localhost:3000",
      "/internal": "http://localhost:3000"
    }
  }
});
