import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // A real DOM: the tests mount a real iframe and dispatch real MessageEvents.
    environment: "jsdom",
    environmentOptions: { jsdom: { url: "https://host.example/" } },
    include: ["src/**/*.test.ts"],
  },
});
