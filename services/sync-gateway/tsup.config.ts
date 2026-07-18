import { defineConfig } from "tsup";

// Render runs `node dist/index.js` directly (no pnpm workspace resolution
// at runtime), and @syncstream/types' package.json "main" points at raw
// src/index.ts - plain node can't execute that TS source. Bundle workspace
// packages into the output so dist/index.js is self-contained for them,
// while leaving real npm dependencies (socket.io, zod, ...) external since
// node_modules exists on the host and there's no reason to duplicate them.
export default defineConfig({
  entry: ["src/index.ts"],
  outDir: "dist",
  format: ["cjs"],
  target: "node20",
  platform: "node",
  bundle: true,
  clean: true,
  sourcemap: true,
  noExternal: [/^@syncstream\//],
  // zod is only a *transitive* import here (via @syncstream/types, which is
  // noExternal'd above) - tsup's auto-external detection only looks at this
  // package's own "dependencies", so without listing it explicitly it would
  // silently get bundled instead of left external. It's also added as a
  // direct dependency in package.json so pnpm actually places it in this
  // package's node_modules for the external require() to resolve on Render.
  external: ["zod"],
});
