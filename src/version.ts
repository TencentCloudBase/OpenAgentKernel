import packageJson from '../package.json' with { type: 'json' }

/** Published package version (single source of truth: package.json). */
export const PACKAGE_VERSION = packageJson.version
