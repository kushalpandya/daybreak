/**
 * Deno does not expose the `Temporal` global at runtime. Its TypeScript lib declares the
 * types, so code compiles, but every call throws `ReferenceError: Temporal is not defined`.
 * No `--unstable-*` or `--v8-flags` option enables it as of Deno 2.9.
 *
 * Import `Temporal` from this module instead of relying on the global. Once Deno ships
 * Temporal natively, this module can re-export the global and the dependency can be dropped.
 */
export { Temporal } from "@js-temporal/polyfill";
