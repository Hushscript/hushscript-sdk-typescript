import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig, type ViteUserConfig } from "vitest/config";

const config: ViteUserConfig = defineConfig({
  test: {
    allowOnly: false,
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/setup.ts"],
    maxWorkers: 4,
    // node_modules is read-only in the containers, where vitest 5 puts its module cache.
    fsModuleCache: false,
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

export default config;
