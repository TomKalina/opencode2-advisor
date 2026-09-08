// Local-path entrypoint for OpenCode's plugin loader: a plugin referenced as a
// directory path is loaded from <dir>/index.ts. The real implementation lives
// in src/index.ts (which is also the package "exports" entry for npm installs).
export { default } from "./src/index.js";
