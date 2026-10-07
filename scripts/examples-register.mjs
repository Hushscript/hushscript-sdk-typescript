// eslint-disable-next-line n/no-unsupported-features/node-builtins -- registered hooks are stable in every Node 22 release we run the examples on; the rule's table lags
import { register } from "node:module";

register("./examples-hooks.mjs", import.meta.url);
