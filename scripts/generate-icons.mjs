import { Resvg } from '@resvg/resvg-js';
import sharp from 'sharp';
import pngToIco from 'png-to-ico';
import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const iconsDir = join(__dirname, '..', 'src-tauri', 'icons');
const svgPath = join(iconsDir, 'icon.svg');

const svgData = readFileSync(svgPath, 'utf8');

// Render SVG at high resolution (1024px) then downscale for quality
const resvg = new Resvg(svgData, {
  fitTo: { mode: 'width', value: 1024 },
  font: { loadSystemFonts: true },
});
const rendered = resvg.render();
const basePng = rendered.asPng();

console.log('SVG rendered to 1024x1024 PNG');

// All required sizes
const sizes = [
  { name: '32x32.png', size: 32 },
  { name: '128x128.png', size: 128 },
  { name: '128x128@2x.png', size: 256 },
  { name: 'icon.png', size: 512 },
  { name: 'Square30x30Logo.png', size: 30 },
  { name: 'Square44x44Logo.png', size: 44 },
  { name: 'Square71x71Logo.png', size: 71 },
  { name: 'Square89x89Logo.png', size: 89 },
  { name: 'Square107x107Logo.png', size: 107 },
  { name: 'Square142x142Logo.png', size: 142 },
  { name: 'Square150x150Logo.png', size: 150 },
  { name: 'Square284x284Logo.png', size: 284 },
  { name: 'Square310x310Logo.png', size: 310 },
  { name: 'StoreLogo.png', size: 50 },
];

for (const { name, size } of sizes) {
  const outPath = join(iconsDir, name);
  await sharp(basePng)
    .resize(size, size, { kernel: sharp.kernel.lanczos3 })
    .png()
    .toFile(outPath);
  console.log(`  ✓ ${name} (${size}x${size})`);
}

// Generate .ico with multiple sizes (16, 24, 32, 48, 64, 128, 256)
const icoSizes = [16, 24, 32, 48, 64, 128, 256];
const icoBuffers = [];
for (const size of icoSizes) {
  const buf = await sharp(basePng)
    .resize(size, size, { kernel: sharp.kernel.lanczos3 })
    .png()
    .toBuffer();
  icoBuffers.push(buf);
}

const icoBuffer = await pngToIco(icoBuffers);
writeFileSync(join(iconsDir, 'icon.ico'), icoBuffer);
console.log('  ✓ icon.ico (multi-size)');

// Note: .icns is macOS only, we generate a 512px PNG as a fallback
// On macOS you'd use iconutil, but for Windows dev we just copy the 512px
await sharp(basePng)
  .resize(512, 512, { kernel: sharp.kernel.lanczos3 })
  .png()
  .toFile(join(iconsDir, 'icon.icns.png'));
console.log('  ✓ icon.icns.png (512px fallback - use iconutil on macOS for real .icns)');

console.log('\nAll icons generated successfully!');
