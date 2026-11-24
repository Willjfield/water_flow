import { defineConfig } from 'vite';

export default defineConfig({
  base: '/water_flow/',
  server: { host: true, port: 5173 },
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
});
