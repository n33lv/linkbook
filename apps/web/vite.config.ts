import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // forward API calls so the FE doesn't deal with CORS in dev
      '/inbox': 'http://localhost:3000',
      '/actions': 'http://localhost:3000',
      '/events': 'http://localhost:3000',
      '/dashboard': 'http://localhost:3000',
      '/integrations': 'http://localhost:3000',
      '/dev': 'http://localhost:3000',
      '/webhooks': 'http://localhost:3000',
      '/healthz': 'http://localhost:3000',
    },
  },
});
