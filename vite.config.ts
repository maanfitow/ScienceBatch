import fs from 'node:fs';
import path from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Serves PDF.js CMaps from `node_modules/pdfjs-dist/cmaps` at `/cmaps/` during
 * Vite dev mode and copies them into `<outDir>/cmaps` on production builds so
 * CJK and custom-encoded PDFs render fully offline.
 */
function pdfjsCmapsPlugin(): Plugin {
  const cmapsDir = path.resolve(__dirname, 'node_modules/pdfjs-dist/cmaps');
  let outDir = path.resolve(__dirname, 'dist');

  return {
    name: 'sciencebatch-pdfjs-cmaps',
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const rawUrl = req.url?.split('?')[0];
        if (!rawUrl || !rawUrl.startsWith('/cmaps/')) {
          next();
          return;
        }

        let decodedPath: string;
        try {
          decodedPath = decodeURIComponent(rawUrl.slice('/cmaps/'.length));
        } catch {
          res.statusCode = 400;
          res.end('Bad Request');
          return;
        }

        const resolvedPath = path.resolve(cmapsDir, decodedPath);
        if (!resolvedPath.startsWith(cmapsDir + path.sep) || !resolvedPath.endsWith('.bcmap')) {
          res.statusCode = 403;
          res.end('Forbidden');
          return;
        }

        fs.readFile(resolvedPath, (err, content) => {
          if (err) {
            res.statusCode = 404;
            res.end('Not Found');
            return;
          }
          res.setHeader('Content-Type', 'application/octet-stream');
          res.end(content);
        });
      });
    },
    closeBundle() {
      if (!fs.existsSync(cmapsDir)) return;
      const targetDir = path.join(outDir, 'cmaps');
      fs.mkdirSync(targetDir, { recursive: true });
      fs.cpSync(cmapsDir, targetDir, { recursive: true });
    },
  };
}

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), pdfjsCmapsPlugin()],
  worker: {
    format: 'es',
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: 'localhost',
  },
  envPrefix: ['VITE_', 'TAURI_ENV_*'],
  build: {
    target: process.env.TAURI_ENV_PLATFORM === 'windows' ? 'chrome105' : 'safari13',
    minify: !process.env.TAURI_ENV_DEBUG ? 'esbuild' : false,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
});
