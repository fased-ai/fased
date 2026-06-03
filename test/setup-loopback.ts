import { afterAll } from "vitest";
import { withIsolatedTestHome } from "./test-env.js";

process.env.VITEST = "true";
process.env.FASED_PLUGIN_MANIFEST_CACHE_MS ??= "60000";

const testEnv = withIsolatedTestHome();

afterAll(() => testEnv.cleanup());
