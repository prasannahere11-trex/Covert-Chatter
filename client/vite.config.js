import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';

export default defineConfig({
  plugins: [react(), basicSsl()],
  server: {
    port: 5174,
    strictPort: true,
    host: true,
    allowedHosts: ['.ngrok-free.dev', '.ngrok-free.app'],
    proxy: {
      '/ws': {
        target: 'http://localhost:8080',
        ws: true,
        rewrite: (path) => path.replace(/^\/ws/, ''),
      },
    },
  },
});

