import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

// WebXR needs a secure context, so `npm run dev` serves over HTTPS with a
// self-signed certificate.  On the Quest, open https://<your-lan-ip>:5173 and
// accept the certificate warning once.
export default defineConfig({
  base: './',
  plugins: [basicSsl()],
  server: { host: true, port: 5173 },
  build: {
    target: 'es2020',
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 2048,
  },
});
