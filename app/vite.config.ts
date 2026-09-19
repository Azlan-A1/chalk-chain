/// <reference types="vitest/config" />
import basicSsl from '@vitejs/plugin-basic-ssl';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

// VITE_HTTPS=1 serves over a self-signed cert so phone cameras and WebCrypto work over the LAN.
// Without VITE_BACKEND_URL the app calls same-origin /api, proxied here to the backend,
// which avoids mixed-content blocks and "localhost" meaning the phone itself.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const target = env.BACKEND_PROXY_TARGET || 'http://localhost:8787';
  // xfwd forwards each phone's IP so the backend rate-limits phones separately.
  const proxy = { '/api': { target, changeOrigin: true, xfwd: true, rewrite: (p: string) => p.replace(/^\/api/, '') } };
  return {
    plugins: [react(), ...(env.VITE_HTTPS === '1' ? [basicSsl()] : [])],
    server: { port: 5173, proxy },
    preview: { port: 4173, proxy },
    test: { environment: 'node', include: ['test/**/*.test.ts'] },
  };
});
