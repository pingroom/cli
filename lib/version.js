// Single-sourced from package.json, which npm always ships inside the tarball,
// so the version can never drift from the package it was published as. The
// GitHub Action pin in action.yml advances separately after npm publication
// is verified. `hook --print-config` emits this version.

import { readFileSync } from 'node:fs';

export const VERSION = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;
