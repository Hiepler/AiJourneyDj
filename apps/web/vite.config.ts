import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Accept the (random) ngrok/tunnel Host header so the dev server doesn't block it.
    allowedHosts: true,
    proxy: {
      "/auth": "http://localhost:3000",
      "/health": "http://localhost:3000",
      "/journeys": "http://localhost:3000",
      "/history": "http://localhost:3000",
      "/internal": "http://localhost:3000",
      // Tesla fetches the partner public key from this path during registration.
      "/.well-known": "http://localhost:3000"
    }
  }
});
