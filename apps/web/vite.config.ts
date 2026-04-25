import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Pin proxy targets to 127.0.0.1 so Node doesn't try ::1 first on macOS
// (uvicorn binds IPv4 only). One env knob if the API moves to a
// different host/port (tests, docker, etc.).
const API_URL = process.env.API_URL ?? 'http://127.0.0.1:3000';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: '127.0.0.1',
    proxy: {
      '/inbox': API_URL,
      '/actions': API_URL,
      '/events': API_URL,
      '/dashboard': API_URL,
      '/integrations': API_URL,
      '/dev': API_URL,
      '/webhooks': API_URL,
      '/healthz': API_URL,
    },
  },
});
