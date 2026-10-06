import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/setup.ts"],
    maxWorkers: 4,
    coverage: {
      provider: "v8",
      // The containers have a read-only root; reports go to the scratch tmpfs.
      reportsDirectory: join(tmpdir(), "coverage"),
      include: ["src/**/*.ts"],
      exclude: ["src/generated/**"],
      reporter: ["text"],
      thresholds: { lines: 90, branches: 85 },
    },
  },
});
