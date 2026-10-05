// Worker entry: enables TypeScript loading inside the worker thread, then runs the real worker.
import { register } from "tsx/esm/api";

register();
await import("./worker.ts");
