// Copy application code, flattened shared modules, UI assets, and configuration
// into the distributable. Missing required inputs fail the build immediately.
import { copyFileSync, cpSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

let root = fileURLToPath(new URL('../', import.meta.url));
let dist = join(root, 'dist');
mkdirSync(dist, { recursive: true });

for (let entry of readdirSync(join(root, 'src'), { withFileTypes: true })) {
  if (entry.isFile() === true && entry.name.endsWith('.js') === true) {
    copyFileSync(join(root, 'src', entry.name), join(dist, entry.name));
  }
}

// Shared modules sit alongside the entry point; their tests stay in source.
for (let name of ['HomeKitDevice', 'HomeKitHistory', 'HomeKitUI']) {
  copyFileSync(join(root, 'src', name, name + '.js'), join(dist, name + '.js'));
}
cpSync(join(root, 'src/HomeKitUI/ui'), join(dist, 'ui'), { recursive: true });
copyFileSync(join(root, 'config.schema.json'), join(dist, 'config.schema.json'));
