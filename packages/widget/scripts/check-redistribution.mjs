import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const { assets } = JSON.parse(
  await readFile(new URL("../licenses/assets.json", import.meta.url), "utf8"),
);
async function matchesProjectException(asset) {
  if (asset.status !== "project-exception" || !asset.ownerDecision || !asset.sha256) return false;
  const bytes = await readFile(new URL(`../${asset.path}`, import.meta.url));
  return createHash("sha256").update(bytes).digest("hex") === asset.sha256;
}

const unresolved = [];
for (const asset of assets) {
  if (asset.status !== "cleared" && !(await matchesProjectException(asset))) {
    unresolved.push(asset);
  }
}
if (unresolved.length > 0) {
  throw new Error(
    `Widget publication blocked: redistribution permission is unresolved for ${unresolved
      .map((asset) => asset.path)
      .join(
        ", ",
      )}. Obtain evidence and update licenses/assets.json; do not replace artwork or assume MIT.`,
  );
}
