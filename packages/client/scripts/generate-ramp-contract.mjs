import { writeFileSync } from "node:fs";
import { z } from "zod";
import { RampWireSchema } from "../src/ramp.ts";

const schema = z.toJSONSchema(RampWireSchema, { target: "draft-7", io: "input" });
schema.$id = "https://xochi.fi/contracts/ramp/1";
schema.title = "ramp/1 public wire contract";
writeFileSync(
  new URL("../ramp/contract.schema.json", import.meta.url),
  `${JSON.stringify(schema, null, 2)}\n`,
);
