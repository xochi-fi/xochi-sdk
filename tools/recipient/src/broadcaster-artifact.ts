// `node dist/broadcaster-artifact.js <artifact>`: scripts/build-broadcaster.sh's gate. The
// validation is the core's (`core/broadcaster-artifact.ts`).

import { OXIDE_BROADCASTER_CLASS_ID } from "./core/broadcaster-artifact.js";
import { loadBroadcasterArtifact } from "./node/artifacts.js";

if (process.argv[1]?.endsWith("/broadcaster-artifact.js")) {
  const path = process.argv[2];
  if (!path) {
    process.stderr.write("usage: node dist/broadcaster-artifact.js <artifact.json>\n");
    process.exit(2);
  }
  loadBroadcasterArtifact(path).then(
    () =>
      process.stdout.write(`${path}: class ${OXIDE_BROADCASTER_CLASS_ID} (deployed Broadcaster)\n`),
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    },
  );
}
