export interface MembershipInput {
  element: string;
  merkleIndex: string;
  merklePath: string[];
  merkleRoot: string;
  setId: string;
  timestamp?: string;
}

export function buildMembershipInputs(opts: MembershipInput): Record<string, string | string[]> {
  if (opts.merklePath.length !== 20) {
    throw new Error(`Merkle path must have 20 elements, got ${String(opts.merklePath.length)}`);
  }

  return {
    element: opts.element,
    merkle_index: opts.merkleIndex,
    merkle_path: opts.merklePath,
    merkle_root: opts.merkleRoot,
    set_id: opts.setId,
    timestamp: opts.timestamp ?? String(Math.floor(Date.now() / 1000)),
    is_member: "1",
  };
}
