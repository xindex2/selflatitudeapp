import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The API port for local development. Keep this in step with PORT in server/.env,
// or set API_PORT for both.
const apiPort = process.env.API_PORT ?? '5111';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5177,
    proxy: {
      '/api': { target: `http://localhost:${apiPort}`, changeOrigin: false },
    },
  },
  build: { outDir: 'dist', sourcemap: false },
});
