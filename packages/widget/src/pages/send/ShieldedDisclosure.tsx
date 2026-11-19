import { SHIELDED_DEPOSIT_NOTE } from "../trade/settlementCopy.js";
import { SHIELDED_DESCRIPTION } from "./sendCopy.js";

export function ShieldedDisclosure() {
  return (
    <>
      <span>{SHIELDED_DESCRIPTION}</span>
      <br />
      <span>{SHIELDED_DEPOSIT_NOTE}</span>
    </>
  );
}
