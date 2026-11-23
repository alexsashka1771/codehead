import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { env } from 'node:process';

const apiTarget = `http://127.0.0.1:${Number(env.CODEHEAD_API_PORT ?? 8010)}`;

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5180,
    strictPort: true,
    proxy: {
      '/api': { target: apiTarget, ws: true },
      '/health': { target: apiTarget },
    },
  },
});
