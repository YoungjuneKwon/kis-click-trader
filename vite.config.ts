import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Development-only, fixed-destination relay. Never deployed by GitHub Pages.
export default defineConfig({
  plugins: [react()],
  base: './',
  server: {
    strictPort: true,
    watch: { usePolling: true, interval: 1500 },
    proxy: {
      '/kis-api/prod': { target: 'https://openapi.koreainvestment.com:9443', changeOrigin: true, rewrite: p => p.replace('/kis-api/prod', '') },
      '/kis-api/vps': { target: 'https://openapivts.koreainvestment.com:29443', changeOrigin: true, rewrite: p => p.replace('/kis-api/vps', '') },
      '/kis-ws-prod': { target: 'ws://ops.koreainvestment.com:21000', ws: true, changeOrigin: true, rewrite: p => p.replace('/kis-ws-prod', '') },
      '/kis-ws-vps': { target: 'ws://ops.koreainvestment.com:31000', ws: true, changeOrigin: true, rewrite: p => p.replace('/kis-ws-vps', '') },
    },
  },
});
