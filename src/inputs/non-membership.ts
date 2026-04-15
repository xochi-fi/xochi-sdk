export interface NonMembershipInput {
  element: string;
  lowLeaf: string;
  highLeaf: string;
  lowIndex: string;
  lowPath: string[];
  highIndex: string;
  highPath: string[];
  merkleRoot: string;
  setId: string;
  timestamp?: string;
}

export function buildNonMembershipInputs(
  opts: NonMembershipInput,
): Record<string, string | string[]> {
  if (opts.lowPath.length !== 20 || opts.highPath.length !== 20) {
    throw new Error("Merkle paths must have 20 elements each");
  }

  return {
    element: opts.element,
    low_leaf: opts.lowLeaf,
    high_leaf: opts.highLeaf,
    low_index: opts.lowIndex,
    low_path: opts.lowPath,
    high_index: opts.highIndex,
    high_path: opts.highPath,
    merkle_root: opts.merkleRoot,
    set_id: opts.setId,
    timestamp: opts.timestamp ?? String(Math.floor(Date.now() / 1000)),
    is_non_member: "1",
  };
}
