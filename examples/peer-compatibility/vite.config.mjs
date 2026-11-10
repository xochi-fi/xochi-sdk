import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    {
      name: "one-peer-sdk",
      buildEnd(error) {
        if (error) return;
        const roots = new Set();
        for (const id of this.getModuleIds()) {
          const sdk = id.match(/^(.*\/node_modules\/@zkp2p\/sdk)\//);
          if (sdk) roots.add(sdk[1]);
          if (/\/node_modules\/@zkp2p\/cash\//.test(id)) {
            this.error("Cash must not enter the selected V4 browser bundle");
          }
        }
        if (roots.size !== 1) this.error("Browser bundle must contain exactly one Peer SDK copy");
      },
    },
  ],
});
