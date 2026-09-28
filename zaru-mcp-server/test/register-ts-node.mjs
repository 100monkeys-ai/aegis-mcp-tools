// Registers ts-node's ESM loader once, for `npm test`.
//
// `node --test --loader ts-node/esm` registers the loader twice in every
// test file's process on Node 24: the test runner passes --loader on to the
// child, and the child registers it again. The second ts-node then
// type-checks the first one's output, which has no types left, and every
// file fails with errors such as "Parameter 'fn' implicitly has an 'any'
// type". Registering through --import happens once per process.
import { register } from "node:module";
import { pathToFileURL } from "node:url";

register("ts-node/esm", pathToFileURL("./"));
