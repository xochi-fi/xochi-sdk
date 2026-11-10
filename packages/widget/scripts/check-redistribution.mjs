import { readFile } from "node:fs/promises";

const { assets } = JSON.parse(
  await readFile(new URL("../licenses/assets.json", import.meta.url), "utf8"),
);
const unresolved = assets.filter((asset) => asset.status !== "cleared");
if (unresolved.length > 0) {
  throw new Error(
    `Widget publication blocked: redistribution permission is unresolved for ${unresolved
      .map((asset) => asset.path)
      .join(
        ", ",
      )}. Obtain evidence and update licenses/assets.json; do not replace artwork or assume MIT.`,
  );
}
