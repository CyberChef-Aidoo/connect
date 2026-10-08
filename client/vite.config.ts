import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const portalBuild = new Date().toISOString().slice(0, 16);

export default defineConfig({
  plugins: [react()],
  define: {
    __PORTAL_BUILD__: JSON.stringify(portalBuild),
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
  },
});
