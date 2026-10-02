import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "server",
    globalSetup: ["src/test/global-setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
