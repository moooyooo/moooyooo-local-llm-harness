import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { DEV_SERVER_PORT, DEV_WEB_PORT } from './shared/ports.ts';

export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: { outDir: '../dist', emptyOutDir: true },
  server: {
    host: '127.0.0.1',
    port: DEV_WEB_PORT,
    strictPort: true,
    proxy: { '/ws': { target: `ws://127.0.0.1:${DEV_SERVER_PORT}`, ws: true } },
  },
});
