// Renders build/icon.png (512x512) from inline SVG. Run: npx electron scripts/make-icon.cjs
const { app, BrowserWindow } = require('electron');
const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const SIZE = 512;
const svg = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <rect width="512" height="512" rx="112" fill="#12141a"/>
  <polyline points="92,330 182,300 246,350 330,214 420,170" fill="none" stroke="#3b82f6" stroke-width="34"
    stroke-linecap="round" stroke-linejoin="round"/>
  <polygon points="420,92 486,206 354,206" fill="#ef4a4a"/>
  <rect x="92" y="392" width="328" height="26" rx="13" fill="#34c77b"/>
</svg>`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: SIZE,
    height: SIZE,
    show: false,
    frame: false,
    transparent: true,
    useContentSize: true,
    webPreferences: { offscreen: true },
  });
  win.webContents.setFrameRate(5);
  let done = false;
  win.webContents.on('paint', (_e, _dirty, image) => {
    if (done || image.isEmpty()) return;
    done = true;
    mkdirSync(join(__dirname, '..', 'build'), { recursive: true });
    writeFileSync(join(__dirname, '..', 'build', 'icon.png'), image.resize({ width: SIZE, height: SIZE }).toPNG());
    app.quit();
  });
  await win.loadURL(`data:text/html,<body style="margin:0;background:transparent">${encodeURIComponent(svg)}</body>`);
});
