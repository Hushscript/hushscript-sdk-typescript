import type { Options } from "tsup";

const config: Options = {
  entry: ["src/index.ts"],
  format: ["esm"],
  // tsup's declaration build sets baseUrl, which TypeScript 6 deprecates.
  dts: { compilerOptions: { ignoreDeprecations: "6.0" } },
  target: "node22",
  platform: "node",
  clean: true,
  treeshake: true,
};

export default config;
