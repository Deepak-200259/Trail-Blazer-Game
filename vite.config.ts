import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  server: {
    // Dev-only: let the game connect to ws(s)://<this dev server>/_mp so HTTPS + wss works and
    // other devices on LAN can use the Vite port (e.g. 5173) when the mp port is firewalled.
    proxy: {
      '/_mp': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
        ws: true,
      },
    },
  },
})
