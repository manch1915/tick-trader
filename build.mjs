import { build } from 'esbuild';
import { cpSync, mkdirSync } from 'node:fs';

const common = { bundle: true, sourcemap: true, logLevel: 'info', target: 'es2022' };

mkdirSync('dist', { recursive: true });

await Promise.all([
  build({ ...common, entryPoints: ['src/main/main.ts'], outfile: 'dist/main.js', platform: 'node', format: 'cjs', external: ['electron'] }),
  // Preloads run sandboxed, so each one is a single CommonJS file that only requires electron.
  build({ ...common, entryPoints: ['src/preload/site.ts'], outfile: 'dist/preload-site.js', platform: 'node', format: 'cjs', external: ['electron'] }),
  build({ ...common, entryPoints: ['src/preload/panel.ts'], outfile: 'dist/preload-panel.js', platform: 'node', format: 'cjs', external: ['electron'] }),
  build({ ...common, entryPoints: ['src/panel/panel.ts'], outfile: 'dist/panel/panel.js', platform: 'browser', format: 'iife' }),
]);

cpSync('src/panel/index.html', 'dist/panel/index.html');
cpSync('src/panel/panel.css', 'dist/panel/panel.css');
