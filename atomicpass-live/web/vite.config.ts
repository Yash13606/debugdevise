import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In development the API runs on :3100 (npm start); the built app is served by that same server.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { '/api': 'http://127.0.0.1:3100' } },
  build: { outDir: 'dist', sourcemap: false },
});
