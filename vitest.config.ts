import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "dist/**", "examples/**"],
    // Much of this suite does real work — writing memory entries to disk,
    // spawning processes, probing for docker — rather than exercising pure
    // functions. Several such tests sat just under vitest's 5s default and
    // failed intermittently once the whole suite ran them in parallel on a busy
    // machine. The ceiling still catches a genuinely hung test; it just stops
    // reporting slow I/O as a failure.
    testTimeout: 30_000,
    hookTimeout: 30_000
  }
});
