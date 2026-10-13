// eslint-disable-next-line n/no-unsupported-features/node-builtins -- registerHooks is available in the pinned Node runtimes used by the examples
import { registerHooks } from "node:module";
import { resolve } from "./examples-hooks.mjs";

registerHooks({ resolve });
