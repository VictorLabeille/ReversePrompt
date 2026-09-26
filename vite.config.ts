import { defineConfig, type Plugin } from 'vite';
import { resolve } from 'node:path';

// Sans barre finale, /playground servait la page de l'overlay (index.html) au lieu du playground.
const playgroundRedirect: Plugin = {
  name: 'playground-redirect',
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      if (req.url === '/playground') {
        res.statusCode = 301;
        res.setHeader('Location', '/playground/');
        res.end();
        return;
      }
      next();
    });
  },
};

// Deux pages : l'overlay de l'app (index.html) et le playground de réglage.
// Elles partagent exactement le même code de rendu (src/).
export default defineConfig({
  plugins: [playgroundRedirect],
  server: { host: '127.0.0.1', port: 5173 },
  build: {
    rolldownOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        playground: resolve(import.meta.dirname, 'playground/index.html'),
      },
    },
  },
});
