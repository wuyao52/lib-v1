import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
    },
  },
  server: {
    port: 3000,
    open: true,
    proxy: {
      '/api/hongniaoai': {
        target: 'https://open.hongniaoai.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/hongniaoai/, '/api'),
        secure: false,
        timeout: 30000,
      },
    },
  },
});
