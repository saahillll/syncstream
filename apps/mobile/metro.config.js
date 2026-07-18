const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

// pnpm workspace layout: this app's real node_modules for hoisted/shared
// packages live at the monorepo root, and workspace packages (@syncstream/*)
// are symlinks. Metro needs to watch the workspace root and follow symlinks
// to resolve them.
const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
];
config.resolver.disableHierarchicalLookup = true;
config.resolver.unstable_enableSymlinks = true;

module.exports = config;
