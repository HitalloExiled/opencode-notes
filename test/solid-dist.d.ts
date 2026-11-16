/**
 * `solid-js/dist/solid.js` is the browser build the DOM test needs — the same
 * one the GUI bundle ships. The package exposes no types for that path, so the
 * module is declared as the package root: the build is the same API, not a
 * shim.
 */
declare module "solid-js/dist/solid.js" {
  export * from "solid-js";
}
