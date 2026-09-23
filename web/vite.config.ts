import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Defaults unchanged. The overrides exist so two checkouts of this repo can
  // run their dev servers at once without fighting over one pair of ports,
  // which is otherwise the only thing stopping parallel review of two branches.
  server: {
    port: Number(process.env.VITE_DEV_PORT ?? 5173),
    proxy: {
      '/api': { target: process.env.VITE_API_TARGET ?? 'http://localhost:4000', changeOrigin: true },
      '/socket.io': { target: process.env.VITE_API_TARGET ?? 'http://localhost:4000', ws: true, changeOrigin: true },
    },
  },
  build: { outDir: 'dist' },
});
