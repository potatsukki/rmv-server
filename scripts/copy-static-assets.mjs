import { mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const staticAssets = [
  {
    source: path.join(rootDir, 'src', 'modules', 'maps', 'data', 'ncr-boundary.json'),
    target: path.join(rootDir, 'dist', 'modules', 'maps', 'data', 'ncr-boundary.json'),
  },
];

for (const asset of staticAssets) {
  await mkdir(path.dirname(asset.target), { recursive: true });
  await copyFile(asset.source, asset.target);
  console.log(`Copied static asset: ${path.relative(rootDir, asset.source)} -> ${path.relative(rootDir, asset.target)}`);
}
