import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          'react-vendor': ['react', 'react-dom', 'zustand'],
          'flow-vendor': ['@xyflow/react'],
          'd3-vendor': ['d3-color', 'd3-dispatch', 'd3-drag', 'd3-ease', 'd3-interpolate', 'd3-selection', 'd3-timer', 'd3-transition', 'd3-zoom'],
          'motion-vendor': ['framer-motion'],
        },
      },
    },
  },
  root: '.',
  resolve: {
    alias: {
      '@': resolve(__dirname, './src').replace(/\\/g, '/'),
    },
  },
  server: {
    port: 3000,
    open: true,
    proxy: {
      '/api/auth': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
      },
      '/api/skills': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
      },
      '/api/director': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
      },
      '/api/hongniaoai': {
        target: 'https://open.hongniaoai.com',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api\/hongniaoai/, '/api'),
        secure: false,
        timeout: 30000,
      },
      '/api/toapis': {
        target: 'https://toapis.com',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api\/toapis\/v1/, '/v1').replace(/^\/api\/toapis/, '/v1'),
        secure: false,
        timeout: 30000,
      },
      '/api/wuhenai': {
        target: 'https://api.wuhenai.com',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api\/wuhenai/, ''),
        secure: false,
        timeout: 30000,
      },
    },
  },
});
