import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const DEV_CSP = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline' http://127.0.0.1:5173",
  "connect-src 'self' ws://127.0.0.1:5173 http://127.0.0.1:5173",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join('; ');

const PROD_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "connect-src 'none'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join('; ');

export default defineConfig(({ mode }) => ({
  root: 'src/renderer',
  base: './',
  plugins: [
    react(),
    {
      name: 'mona-csp',
      transformIndexHtml(html) {
        return html.replace('__MONA_CSP__', mode === 'development' ? DEV_CSP : PROD_CSP);
      },
    },
  ],
  build: {
    outDir: '../../dist/renderer',
    emptyOutDir: true,
    sourcemap: true,
    target: 'chrome130',
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
}));
