import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const api = process.env.VITE_DEV_API || 'http://127.0.0.1:8080';

export default defineConfig({
  plugins: [react()],
  // one .env at the repo root; only VITE_* keys reach the browser bundle
  envDir: '..',
  server: {
    port: 5173,
    host: true,
    proxy: { '/api': api, '/media': api, '/dj': api },
  },
  build: {
    target: ['es2020', 'safari15', 'chrome100'],
    cssCodeSplit: true,
    rollupOptions: {
      output: {
        manualChunks: (id) => (id.includes('node_modules/react') ? 'react' : undefined),
      },
    },
  },
});
