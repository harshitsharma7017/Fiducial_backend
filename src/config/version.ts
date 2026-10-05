import { readFileSync } from 'node:fs';

// Resolves to the repo's package.json from both src/config and dist/config.
const packageJson = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as { version?: string };

export const API_VERSION = packageJson.version ?? '0.0.0';
