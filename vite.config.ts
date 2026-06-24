import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': '/src',
    },
  },
  server: {
    port: 3000,
    open: true,
    proxy: {
      '/api/hongniaoai': {
        target: 'https://open.hongniaoai.com',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api\/hongniaoai/, '/api'),
        secure: false,
        timeout: 30000,
      },
    },
  },
});
