import { isAbsolute, resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const dependencyRoot = process.env.CODEHEAD_CLINIC_NODE_MODULES;
if (dependencyRoot && !isAbsolute(dependencyRoot)) {
  throw new Error('The trusted Clinic dependency cache must use an absolute path.');
}

export default defineConfig({
  plugins: [react()],
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: dependencyRoot ? [
      { find: /^react(?=\/|$)/, replacement: resolve(dependencyRoot, 'react') },
      { find: /^react-dom(?=\/|$)/, replacement: resolve(dependencyRoot, 'react-dom') },
    ] : [],
  },
  server: {
    host: '127.0.0.1',
    port: 5181,
    strictPort: true,
    proxy: { '/api': 'http://127.0.0.1:8081', '/health': 'http://127.0.0.1:8081' },
  },
  build: { outDir: 'dist', emptyOutDir: false },
});
