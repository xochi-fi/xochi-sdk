// Holds `conformance/shielded-recipient.json` to the real, exact-pinned Aztec SDKs: the
// `@aztec/*` 5.2.0 line (Aztec mainnet) and the `@aztec-labs/*` 6.0.0 line (the public
// testnet, corridor manifest revision 1). The generator never imports an SDK; this is the
// "one side this repo cannot edit" for every Aztec-specific value in that file:
//
//   - the pinned SchnorrAccount class id, artifact hash and initializerless sibling;
//   - the constructor selector and every DomainSeparator the derivation uses;
//   - each TEST-ONLY fixture account's keys (stdlib deriveKeys, bb.js computePublicKey);
//   - every descriptor's address and derivation intermediate, through the SDK's own
//     getContractInstanceFromInstantiationParams / computePartialAddress / computePreaddress;
//   - the descriptor refusals that are SDK-observable (address and on-curve verdicts);
//   - the wide reduction (Fr.fromBufferReduce on the 48 bytes);
//   - every Schnorr signature and replay verdict, through bb.js, under BOTH SDKs.
//   - each passkey recipient (`passkey`, 6.0.0): the wide reduction of its HKDF outputs and the
//     CLI's account from the derived secret and salt (deriveKeys, the MSSK_M signing key).
//
// Its own package (not a workspace) so ~850 MB of SDK stays out of every other CI job.
//
//   cd packages/spec/aztec-crosscheck && npm ci && npm run crosscheck
//   (= tsx crosscheck.ts aztec-5.2.0 && tsx crosscheck.ts aztec-6.0.0)

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// Dynamic imports, deliberately: one SDK line per process. The two bb.js builds cannot
// share one (the 6.0.0 line fails with "Unknown type name in NamedUnion deserialization"
// once 5.2.0's is loaded), so the line is chosen at runtime from argv.
async function load52() {
  return {
    accounts: await import("@aztec/accounts/schnorr"),
    constants: await import("@aztec/constants"),
    schnorr: await import("@aztec/foundation/crypto/schnorr"),
    bn: await import("@aztec/foundation/curves/bn254"),
    grumpkin: await import("@aztec/foundation/curves/grumpkin"),
    abi: await import("@aztec/stdlib/abi"),
    addr: await import("@aztec/stdlib/aztec-address"),
    contract: await import("@aztec/stdlib/contract"),
    keys: await import("@aztec/stdlib/keys"),
  };
}
// One module set's shape stands for both: the two lines share this API.
type Sdk = Awaited<ReturnType<typeof load52>>;
async function load60(): Promise<Sdk> {
  return {
    accounts: await import("@aztec-labs/accounts/schnorr"),
    constants: await import("@aztec-labs/constants"),
    schnorr: await import("@aztec-labs/foundation/crypto/schnorr"),
    bn: await import("@aztec-labs/foundation/curves/bn254"),
    grumpkin: await import("@aztec-labs/foundation/curves/grumpkin"),
    abi: await import("@aztec-labs/stdlib/abi"),
    addr: await import("@aztec-labs/stdlib/aztec-address"),
    contract: await import("@aztec-labs/stdlib/contract"),
    keys: await import("@aztec-labs/stdlib/keys"),
  } as unknown as Sdk;
}
const LOADERS: Record<string, () => Promise<Sdk>> = {
  "aztec-5.2.0": load52,
  "aztec-6.0.0": load60,
};
const PROFILE = process.argv[2] ?? "";
if (!(PROFILE in LOADERS)) {
  console.error(`usage: tsx crosscheck.ts <${Object.keys(LOADERS).join("|")}>`);
  process.exit(2);
}
const loaded = await LOADERS[PROFILE]();

const here = path.dirname(fileURLToPath(import.meta.url));
const file = JSON.parse(
  fs.readFileSync(path.join(here, "../conformance/shielded-recipient.json"), "utf8"),
);

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (ok) passed++;
  else {
    failed++;
    console.log(`FAIL ${label}${detail ? `  ${detail}` : ""}`);
  }
}
const eq = (label: string, actual: unknown, expected: unknown) =>
  check(label, String(actual) === String(expected), `got ${actual}, expected ${expected}`);

const fr = (sdk: Sdk, hex: string) => sdk.bn.Fr.fromString(hex);
const point = (sdk: Sdk, x: string, y: string) =>
  new sdk.grumpkin.Point(fr(sdk, x), fr(sdk, y), false);
const publicKeysOf = (sdk: Sdk, d: Record<string, string>) =>
  new sdk.keys.PublicKeys(
    fr(sdk, d.npkMHash),
    point(sdk, d.ivpkMX, d.ivpkMY),
    fr(sdk, d.ovpkMHash),
    fr(sdk, d.tpkMHash),
    fr(sdk, d.mspkMHash),
    fr(sdk, d.fbpkMHash),
  );
const instanceOf = (
  sdk: Sdk,
  d: Record<string, string>,
  classArtifact = sdk.accounts.SchnorrAccountContractArtifact,
) =>
  sdk.contract.getContractInstanceFromInstantiationParams(classArtifact, {
    constructorArgs: [fr(sdk, d.signingPublicKeyX), fr(sdk, d.signingPublicKeyY)],
    salt: fr(sdk, d.salt),
    deployer: sdk.addr.AztecAddress.fromStringUnsafe(d.deployer),
    publicKeys: publicKeysOf(sdk, d),
  });

/** The SDK's own address for a descriptor whose class id may not be the shipped one. */
async function sdkAddress(sdk: Sdk, d: Record<string, string>): Promise<string> {
  const instance = await instanceOf(sdk, d);
  const forged = {
    ...instance,
    originalContractClassId: fr(sdk, d.classId),
    currentContractClassId: fr(sdk, d.classId),
  };
  return (await sdk.contract.computeContractAddressFromInstance(forged)).toString();
}

async function schnorrVerdict(sdk: Sdk, m: string, pk: { x: string; y: string }, sig: string) {
  try {
    return await new sdk.schnorr.Schnorr().verifySignature(
      fr(sdk, m),
      point(sdk, pk.x, pk.y),
      new sdk.schnorr.SchnorrSignature(Buffer.from(sig.slice(2), "hex")),
    );
  } catch (err) {
    return `threw: ${err instanceof Error ? err.message : String(err)}`;
  }
}

const DS = file.descriptor;
for (const profile of DS.profiles.filter((p: { id: string }) => p.id === PROFILE)) {
  const id: string = profile.id;
  const sdk = loaded;
  const tag = `[${id}]`;

  // Class identity of the shipped artifacts.
  const cls = await sdk.contract.getContractClassFromArtifact(
    sdk.accounts.SchnorrAccountContractArtifact,
  );
  eq(`${tag} SchnorrAccount class id == pin`, cls.id, profile.pinnedClassId);
  eq(`${tag} SchnorrAccount artifactHash`, cls.artifactHash, profile.artifactHash);
  const sibling = await sdk.contract.getContractClassFromArtifact(
    sdk.accounts.SchnorrInitializerlessAccountContractArtifact,
  );
  eq(`${tag} SchnorrInitializerlessAccount class id`, sibling.id, profile.initializerlessClassId);

  // Constructor selector and separators.
  const ctor = sdk.accounts.SchnorrAccountContractArtifact.functions.find(
    (f: { name: string }) => f.name === "constructor",
  )!;
  const selector = await sdk.abi.FunctionSelector.fromNameAndParameters(ctor.name, ctor.parameters);
  eq(`${tag} constructor selector`, selector.toField(), DS.constructorSelector);
  const sep = sdk.constants.DomainSeparator as unknown as Record<string, number>;
  for (const [name, value] of Object.entries(DS.separators as Record<string, string>)) {
    eq(`${tag} DomainSeparator.${name}`, sep[name], value);
  }
  eq(
    `${tag} DomainSeparator.${profile.contractAddressSeparator.name}`,
    sep[profile.contractAddressSeparator.name],
    profile.contractAddressSeparator.value,
  );

  for (const v of DS.vectors.filter((x: { profile: string }) => x.profile === id)) {
    const d = v.descriptor;
    const vt = `${tag} ${v.name}`;
    // The TEST-ONLY fixture keys, derived the stock way.
    const keys = await sdk.keys.deriveKeys(fr(sdk, v.testOnlySecrets.secretKey));
    check(
      `${vt} deriveKeys(secretKey).publicKeys == descriptor`,
      keys.publicKeys.equals(publicKeysOf(sdk, d)),
    );
    const signing = await new sdk.schnorr.Schnorr().computePublicKey(
      sdk.grumpkin.GrumpkinScalar.fromString(v.testOnlySecrets.signingPrivateKey),
    );
    eq(`${vt} signing key x`, signing.x, d.signingPublicKeyX);
    eq(`${vt} signing key y`, signing.y, d.signingPublicKeyY);
    // The SDK's own instance and address.
    const instance = await instanceOf(sdk, d);
    eq(`${vt} SDK address == descriptor.aztecAddress`, instance.address, d.aztecAddress);
    eq(`${vt} SDK address == derivation.address`, instance.address, v.derivation.address);
    eq(`${vt} initializationHash`, instance.initializationHash, v.derivation.initializationHash);
    eq(`${vt} immutablesHash`, instance.immutablesHash, v.derivation.immutablesHash);
    eq(
      `${vt} saltedInitializationHash`,
      await sdk.contract.computeSaltedInitializationHash(instance),
      v.derivation.saltedInitializationHash,
    );
    eq(
      `${vt} partialAddress`,
      await sdk.contract.computePartialAddress(instance),
      v.derivation.partialAddress,
    );
    const pkHash = await instance.publicKeys.hash();
    eq(`${vt} publicKeysHash`, pkHash, v.derivation.publicKeysHash);
    eq(
      `${vt} ivpkMHash`,
      await sdk.keys.hashPublicKey(instance.publicKeys.ivpkM),
      v.derivation.ivpkMHash,
    );
    eq(
      `${vt} preaddress`,
      await sdk.keys.computePreaddress(pkHash, await sdk.contract.computePartialAddress(instance)),
      v.derivation.preaddress,
    );
    eq(`${vt} class id`, instance.originalContractClassId, d.classId);
    check(
      `${vt} signing key on Grumpkin`,
      point(sdk, d.signingPublicKeyX, d.signingPublicKeyY).isOnCurve(),
    );
    check(`${vt} ivpk_m on Grumpkin`, point(sdk, d.ivpkMX, d.ivpkMY).isOnCurve());
  }

  // Refusals the SDK can observe.
  for (const r of DS.refusals.filter((x: { profile: string }) => x.profile === id)) {
    const d = r.descriptor;
    const rt = `${tag} refusal "${r.name}"`;
    switch (r.error.code) {
      case "address_mismatch":
        check(
          `${rt}: SDK address differs from the claim`,
          (await sdkAddress(sdk, d)) !== d.aztecAddress,
        );
        break;
      case "class_not_pinned":
        check(`${rt}: class is not the shipped artifact's`, d.classId !== cls.id.toString());
        eq(
          `${rt}: forgery is self-consistent under the SDK`,
          await sdkAddress(sdk, d),
          d.aztecAddress,
        );
        break;
      case "signing_key_invalid": {
        // (0, 0) is the SDK's encoding of the point at infinity, which it calls on-curve.
        const p = point(sdk, d.signingPublicKeyX, d.signingPublicKeyY);
        check(`${rt}: SDK says off curve or infinity`, !p.isOnCurve() || p.isInfinite);
        eq(
          `${rt}: forgery is self-consistent under the SDK`,
          await sdkAddress(sdk, d),
          d.aztecAddress,
        );
        break;
      }
      case "ivpk_invalid": {
        const p = point(sdk, d.ivpkMX, d.ivpkMY);
        check(`${rt}: SDK says off curve or infinity`, !p.isOnCurve() || p.isInfinite);
        break;
      }
      default:
        break; // encoding refusals: below the SDK's level (it would throw or reduce)
    }
  }

  // The cross-profile pair: same keys, salt and deployer.
  const cp = file.descriptor.crossProfile;
  const keysFrom = DS.vectors.find((x: { name: string }) => x.name === cp.keysFrom).descriptor;
  eq(
    `${tag} crossProfile address`,
    (await instanceOf(sdk, { ...keysFrom, classId: profile.pinnedClassId })).address,
    cp.addresses[id],
  );

  // Wide reduction: the SDK's own Fr.fromBufferReduce on the 48 bytes.
  const RM = file.recipientMessage;
  for (const v of RM.reduction) {
    eq(
      `${tag} reduction "${v.name}"`,
      sdk.bn.Fr.fromBufferReduce(Buffer.from(v.u48.slice(2), "hex")),
      v.messageField,
    );
  }

  // Every Schnorr signature and replay, through bb.js.
  const passkeySigned = [file.passkey.backup.binding, ...file.passkey.backup.acks];
  for (const v of [...RM.bindingMessages, ...file.acknowledgements.vectors, ...passkeySigned]) {
    eq(
      `${tag} Fr.fromBufferReduce(u48) "${v.name}"`,
      sdk.bn.Fr.fromBufferReduce(Buffer.from(v.wrapper.u48.slice(2), "hex")),
      v.wrapper.messageField,
    );
    eq(
      `${tag} bb.js verifies "${v.name}"`,
      await schnorrVerdict(sdk, v.wrapper.messageField, v.publicKey, v.signature),
      true,
    );
  }
  for (const v of RM.refusals) {
    eq(
      `${tag} bb.js refuses "${v.name}"`,
      await schnorrVerdict(sdk, v.messageField, v.publicKey, v.signature),
      false,
    );
    eq(
      `${tag} bb.js: "${v.name}" signs signedField`,
      await schnorrVerdict(sdk, v.signedField, v.publicKey, v.signature),
      !v.name.includes("other account's key"),
    );
  }
  for (const v of [
    ...file.acknowledgements.crossTypeReplays,
    ...file.acknowledgements.crossBindingReplays,
  ]) {
    eq(
      `${tag} bb.js refuses "${v.name}"`,
      await schnorrVerdict(sdk, v.messageField, v.publicKey, v.signature),
      false,
    );
  }
}

// OxideToken immutables (xochi#753, 6.0.0 only: the 5.2.0 instance has no immutablesHash).
// The hash goes through the SDK's poseidon2HashWithSeparator; the address through
// computeContractAddressFromInstance for the universal, initializerless, default-keys
// instance, held to the DEPLOYED OXDAI address the vector records.
if (PROFILE === "aztec-6.0.0") {
  const sdk = loaded;
  // Dynamic like every SDK module here: one SDK line per process (see load52 / load60).
  const { poseidon2HashWithSeparator } = await import("@aztec-labs/foundation/crypto/poseidon");
  const OX = file.oxideToken;
  for (const v of OX.vectors) {
    const hash = await poseidon2HashWithSeparator(
      v.serialized.map((s: string) => fr(sdk, s)),
      Number(BigInt(OX.separator)),
    );
    eq(`oxide immutablesHash "${v.name}"`, hash.toString(), v.immutablesHash);
    if (v.address === null) continue;
    const instance = {
      version: 1,
      salt: fr(sdk, v.instance.salt),
      deployer: sdk.addr.AztecAddress.fromStringUnsafe(v.instance.deployer),
      originalContractClassId: fr(sdk, v.classId),
      currentContractClassId: fr(sdk, v.classId),
      initializationHash: fr(sdk, v.instance.initializationHash),
      publicKeys: sdk.keys.PublicKeys.default(),
      immutablesHash: hash,
    };
    // `Sdk` is typed from the 5.2.0 line, whose instance has no immutablesHash; the 6.0.0
    // computeContractAddressFromInstance reads it.
    const forSdk = instance as unknown as Parameters<
      typeof sdk.contract.computeContractAddressFromInstance
    >[0];
    eq(
      `oxide deployed address "${v.name}"`,
      (await sdk.contract.computeContractAddressFromInstance(forSdk)).toString(),
      v.address,
    );
  }
}

// Passkey recipients (xochi-sdk#155, 6.0.0 only: the recipient CLI's line). Each derived secret
// and salt is the SDK's own wide reduction of the published HKDF output, and the account is
// what the CLI builds from them: deriveMasterMessageSigningSecretKey(secret) signs,
// deriveKeys(secret) gives the public keys, the derived salt, deployer zero.
if (PROFILE === "aztec-6.0.0") {
  const sdk = loaded;
  for (const d of file.passkey.derivations) {
    const pt = `passkey "${d.name}"`;
    const desc = d.account.descriptor;
    eq(
      `${pt} secret == Fr.fromBufferReduce(hkdf accountSecret)`,
      sdk.bn.Fr.fromBufferReduce(Buffer.from(d.hkdfOutput.accountSecret.slice(2), "hex")),
      d.secret,
    );
    eq(
      `${pt} salt == Fr.fromBufferReduce(hkdf accountSalt)`,
      sdk.bn.Fr.fromBufferReduce(Buffer.from(d.hkdfOutput.accountSalt.slice(2), "hex")),
      d.salt,
    );
    const secret = fr(sdk, d.secret);
    const keys = await sdk.keys.deriveKeys(secret);
    check(
      `${pt} deriveKeys(secret).publicKeys == descriptor`,
      keys.publicKeys.equals(publicKeysOf(sdk, desc)),
    );
    const signingKey = sdk.keys.deriveMasterMessageSigningSecretKey(secret);
    eq(`${pt} signing key == MSSK_M`, signingKey, d.account.testOnlySecrets.signingPrivateKey);
    const signing = await new sdk.schnorr.Schnorr().computePublicKey(signingKey);
    eq(`${pt} signing key x`, signing.x, desc.signingPublicKeyX);
    eq(`${pt} signing key y`, signing.y, desc.signingPublicKeyY);
    eq(`${pt} descriptor salt`, desc.salt, d.salt);
    eq(`${pt} deployer zero`, desc.deployer, sdk.addr.AztecAddress.ZERO.toString());
    const instance = await instanceOf(sdk, desc);
    eq(`${pt} SDK address == descriptor.aztecAddress`, instance.address, desc.aztecAddress);
    eq(`${pt} SDK address == derivation.address`, instance.address, d.account.derivation.address);
    eq(`${pt} class id`, instance.originalContractClassId, desc.classId);
  }
}

console.log(`aztec-crosscheck: ${passed} PASS / ${failed} FAIL`);
process.exit(failed === 0 && passed > 0 ? 0 : 1);
