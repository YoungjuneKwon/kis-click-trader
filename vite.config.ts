import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Frontend development uses the authenticated Node backend on port 5197.
export default defineConfig({
  plugins: [react()],
  base: './',
  server: {
    strictPort: true,
    watch: { usePolling: true, interval: 1500 },
    proxy: {
      '/api': { target: 'http://127.0.0.1:5197', ws: true },
    },
  },
});
