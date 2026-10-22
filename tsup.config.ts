import type { Options } from "tsup";

const config: Options = {
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  target: "node24",
  platform: "node",
  clean: true,
  treeshake: true,
};

export default config;
