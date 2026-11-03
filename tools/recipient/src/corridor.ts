// The corridor record the tool trusts: everything it pins the network, the token, the
// senders and the enrollment binding to. The built-in record is the OXDAI corridor on Aztec v6
// mainnet, manifest revision 2 (xochi#737, xochi#778). A record can also be read from a file
// (`--corridor`), validated by the same schema; it is never taken from the enrollment API.

import { z } from "zod4";

const hex32 = z.string().regex(/^0x[0-9a-f]{64}$/, "lowercase 0x + 64 hex");
const evm = z.string().regex(/^0x[0-9a-f]{40}$/, "lowercase 0x + 40 hex");
const decimal = z.string().regex(/^(0|[1-9][0-9]*)$/, "canonical decimal");

export const CorridorSchema = z
  .object({
    /** A label for the operator; not hashed. */
    name: z.string().min(1),
    environment: z.string().min(1),
    sourceChainId: decimal,
    corridorId: hex32,
    corridorRevision: decimal,
    manifestDigest: hex32,
    /** `@xochi/signer` `AZTEC_RECIPIENT_PROFILES` key; the recipient class is that profile's. */
    profile: z.literal("aztec-6.0.0"),
    network: z
      .object({
        aztecChainId: decimal,
        protocolVersion: decimal,
        rollupAddress: evm,
        l1ChainId: decimal,
        genesisOrNetworkDigest: hex32,
      })
      .strict(),
    /** The corridor's paying Aztec accounts, strictly ascending (SenderRegistrationAck). */
    registeredSenders: z.array(hex32).min(1).max(16),
    token: z
      .object({
        address: hex32,
        classId: hex32,
        /** The manifest's `aztecTokenArtifactDigest`: the class's in-protocol `artifactHash` (rev 2). */
        artifactHash: hex32,
        /** The manifest's `l2TokenImmutables`, never the portal's underlying ERC-20 metadata. */
        immutables: z
          .object({
            portal: evm,
            teeRegistry: evm,
            name: z.string().min(1),
            symbol: z.string().min(1),
            decimals: z.number().int().min(0).max(255),
            maxNoteAmount: decimal,
          })
          .strict(),
      })
      .strict(),
    oxide: z
      .object({
        /** Oxide v6 deployment the enclave pins come from (releases.json). */
        deploymentId: z.string().min(1),
        gitSha: z.string().regex(/^[0-9a-f]{40}$/),
        enclaveUrl: z.url(),
        teeRegistry: evm,
        certManager: evm,
        pcr0: z.string().regex(/^[0-9a-f]{96}$/),
        pcr0Hash: hex32,
        rootCaCertHash: hex32,
        plainWithdrawalExecutor: evm,
        l2Broadcaster: hex32,
        /** The token the withdrawal executor pays the relayer tip in (L1 DAI). */
        payoutToken: evm,
      })
      .strict(),
  })
  .strict()
  .superRefine((c, ctx) => {
    for (let i = 1; i < c.registeredSenders.length; i++) {
      if (BigInt(c.registeredSenders[i]!) <= BigInt(c.registeredSenders[i - 1]!)) {
        ctx.addIssue({
          code: "custom",
          path: ["registeredSenders"],
          message: "must be strictly ascending",
        });
      }
    }
  });

export type Corridor = z.infer<typeof CorridorSchema>;

/**
 * OXDAI on Aztec v6 mainnet, manifest revision 2. Every value is from xochi#778's
 * `OXDAI_REV2_ENTRY` and pxe-bridge `src/oxide/pins.ts` (`OXIDE_V6_MAINNET`). `manifestDigest`
 * is the agreed rev 2 digest (#736 sync 2026-11-03): Riddler#1437 records the same value in
 * `approved_mainnet/0` and xochi#778 pins it in the Worker (OX-4). `environment` is the Worker's
 * `SHIELDED_CORRIDOR_CONFIG` environment for production (the manifest's `environment`).
 */
export const OXDAI_MAINNET_REV2: Corridor = CorridorSchema.parse({
  name: "oxdai-mainnet-rev2",
  environment: "production",
  sourceChainId: "1",
  // keccak256("xochi.shielded.corridor.ethereum-usdc.aztec-mainnet-oxdai.a-tracer")
  corridorId: "0x2e6bcdd1a54e69d67e053620c8eb9451fe7ea0a81ffcd7da17627bd448739bc0",
  corridorRevision: "2",
  // Agreed rev 2 digest (#736 sync 2026-11-03); equal in Riddler, ansible-riddler and pxe-bridge.
  manifestDigest: "0x80b6abd7253f55f0014b37bc20e4c02b71dfc718e1181a730c0699b979d9865e",
  profile: "aztec-6.0.0",
  network: {
    aztecChainId: "1",
    protocolVersion: "2070860440",
    rollupAddress: "0xe37a2663cc9c119ba41572c40fab0bbb23a5402f",
    l1ChainId: "1",
    // Aztec mainnet block 1 `lastArchive.root` (xochi#778).
    genesisOrNetworkDigest: "0x29eb2c527f8d45276430363214e6c8d709ef3f657a3670ebac3179373d41e5c4",
  },
  // The dedicated Oxide sender (pxe-bridge#84), approved 2026-11-02.
  registeredSenders: ["0x15ff3aa2270843241b4405bfc8ba72ae59b68c85996cff9e5c03daf03109cb22"],
  token: {
    address: "0x11d2bed21a36289fd6f6a6af93a546b5be7115caf957f0f700f42d56e25fe0a3",
    classId: "0x27df40f914de0e4368b39b4d02821d42573dfe703502c3e7a44f5254345f3949",
    artifactHash: "0x128f498e06c59eeecdfcf41b96b3698bae23826ce3fb8608617e0a3084532f5f",
    immutables: {
      portal: "0xcb99c58fe81ae6b2cb4835e46f7b703745879042",
      teeRegistry: "0x8b705c3519169f29850d156574ec377b686bd9cd",
      name: "Oxide DAI",
      symbol: "OXDAI",
      decimals: 18,
      maxNoteAmount: "5166000000000000000000",
    },
  },
  oxide: {
    deploymentId: "dep-v6",
    gitSha: "3d8e29dc359023012a91d75538ed757dc9add937",
    enclaveUrl: "https://flt-v6.v6-prod.oxide.zk.money/rpc",
    teeRegistry: "0x8b705c3519169f29850d156574ec377b686bd9cd",
    certManager: "0xe3dddf3d4b624f49b4ceb81807338cca14f5dd86",
    pcr0: "4d28e5b10f51d67b1383f1cf738b567fe9e19efa6043d8470a5dad299d2e30c9e76e7493c0df7bb5e9c2cc2156348b73",
    pcr0Hash: "0xf8c74ed4c30d08100cf653c802123b07a6880f3e2601e23d6bfd498d9db0423a",
    rootCaCertHash: "0x311d96fcd5c5e0ccf72ef548e2ea7d4c0cd53ad7c4cc49e67471aed41d61f185",
    // releases.json dep-v6, brg-dai-v6 and the deployment's l2Broadcaster / feeToken.
    plainWithdrawalExecutor: "0x7c8c2147d1bb8b83e0a0501097372de170ee702a",
    l2Broadcaster: "0x1baa45197097c8c59887433f6b530c031b885002cb757ed8a9ecd0b8abf277f9",
    payoutToken: "0x6b175474e89094c44da98b954eedeac495271d0f",
  },
});

/** Parses a corridor record file's JSON, refusing anything the schema does not admit. */
export function parseCorridor(json: unknown): Corridor {
  return CorridorSchema.parse(json);
}
