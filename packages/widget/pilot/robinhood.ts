/**
 * Run with node --import tsx. The key stays in this process and the adapter
 * never exposes an ordinary transaction method. All signing is interactive.
 */
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { connect, getAccount } from "wagmi/actions";
import { createConfig, createConnector, type CreateConnectorFn } from "wagmi";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  erc20Abi,
  getAddress,
  http,
  isHash,
  numberToHex,
  parseAbi,
  parseEventLogs,
  sha256,
  type Address,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { ROBINHOOD_TESTNET_CHAIN_ID, SIMPLE_ACCOUNT_FACTORY, USDG_ADDRESSES } from "@xochi/client";
import { ENTRYPOINT_V08_ADDRESS, PERMIT2_ADDRESS } from "@xochi/signer";
import { configureWidget } from "../src/config.js";
import { resolveOriginSponsorship, SIMPLE_7702_DELEGATE } from "../src/lib/originSponsorship.js";
import type { OriginSponsorshipAction } from "../src/types/originSponsorship.js";

const [mode, keyFile, value, extra] = process.argv.slice(2);
if (!keyFile || !["init", "inventory", "delegate", "send", "approve", "status"].includes(mode))
  throw new Error(
    "Usage: robinhood.ts init|inventory|delegate|send|approve|status KEY_FILE [ATOMIC_AMOUNT|CHECKPOINT|PAYER_KEY_FILE] [RECIPIENT|QUOTE_ID]",
  );
if (mode === "init") writeFileSync(keyFile, generatePrivateKey(), { flag: "wx", mode: 0o600 });
if ((statSync(keyFile).mode & 0o077) !== 0)
  throw new Error("Restrict the disposable key file to its owner");
const owner = privateKeyToAccount(readFileSync(keyFile, "utf8").trim() as Hex);
if (mode === "init") {
  console.log(JSON.stringify({ owner: owner.address }));
  process.exit(0);
}

const chainId = ROBINHOOD_TESTNET_CHAIN_ID;
const rpcUrl = process.env.ITEM143_TESTNET_RPC || "https://rpc.testnet.chain.robinhood.com";
const chain = defineChain({
  id: chainId,
  name: "Robinhood Testnet",
  testnet: true,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
});
const transport = http(rpcUrl, { timeout: 10_000, retryCount: 0 });
const client = createPublicClient({ chain, transport });
if ((await client.getChainId()) !== chainId)
  throw new Error("RPC is not on the authorized testnet");
const token = getAddress(USDG_ADDRESSES[chainId]!);
const permit2 = getAddress(PERMIT2_ADDRESS);
const entryPoint = getAddress(ENTRYPOINT_V08_ADDRESS);
const factory = getAddress(SIMPLE_ACCOUNT_FACTORY);
const factoryAbi = parseAbi(["function getAddress(address,uint256) view returns (address)"]);
const derived = await client.readContract({
  address: factory,
  abi: factoryAbi,
  functionName: "getAddress",
  args: [owner.address, 0n],
});
const userOpEvent = parseAbi([
  "event UserOperationEvent(bytes32 indexed userOpHash,address indexed sender,address indexed paymaster,uint256 nonce,bool success,uint256 actualGasCost,uint256 actualGasUsed)",
]);
const designation = `0xef0100${SIMPLE_7702_DELEGATE.slice(2).toLowerCase()}`;
const delegated = (await client.getCode({ address: owner.address }))?.toLowerCase() === designation;

const balance = (address: Address) =>
  client.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [address],
  });
async function snapshot(sender: Address, recipient?: Address) {
  return {
    native: (await client.getBalance({ address: sender })).toString(),
    usdg: (await balance(sender)).toString(),
    allowance: (
      await client.readContract({
        address: token,
        abi: erc20Abi,
        functionName: "allowance",
        args: [sender, permit2],
      })
    ).toString(),
    ...(recipient && { recipientUsdg: (await balance(recipient)).toString() }),
  };
}

if (mode === "inventory") {
  console.log(
    JSON.stringify(
      {
        chainId,
        token,
        owner: owner.address,
        delegated,
        factorySender: derived,
        ownerState: await snapshot(owner.address),
        factoryState: await snapshot(derived),
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

if (!process.stdin.isTTY) throw new Error("Use an interactive terminal for owner signatures");
const prompts = createInterface({ input: process.stdin, output: process.stderr });
async function confirm(message: string) {
  if (
    (
      await prompts.question(`${message}
Type yes to sign: `)
    ).trim() !== "yes"
  )
    throw new Error("Owner declined");
}
if (mode === "delegate") {
  try {
    if (!value || (statSync(value).mode & 0o077) !== 0)
      throw new Error("Provide a private, disposable payer key file");
    const payer = privateKeyToAccount(readFileSync(value, "utf8").trim() as Hex);
    const ownerCode = await client.getCode({ address: owner.address });
    if (
      payer.address === owner.address ||
      ownerCode ||
      (await client.getBalance({ address: owner.address })) !== 0n
    )
      throw new Error("Expected a distinct payer and an undelegated zero-native owner");
    const runtime = await client.getCode({ address: SIMPLE_7702_DELEGATE });
    if (
      !runtime ||
      sha256(runtime) !== "0x2152bba1e68a2386a64a814981ff552d64a8230e555e21d2a90a036060d181f2" ||
      (await client.getBalance({ address: payer.address })) === 0n
    )
      throw new Error("Canonical delegate and funded testnet payer required");
    const nonce = await client.getTransactionCount({ address: owner.address });
    await confirm(
      JSON.stringify({
        chainId,
        owner: owner.address,
        payer: payer.address,
        delegate: SIMPLE_7702_DELEGATE,
        nonce,
      }),
    );
    const authorization = await owner.signAuthorization({
      chainId,
      contractAddress: SIMPLE_7702_DELEGATE,
      nonce,
    });
    const payerClient = createWalletClient({ account: payer, chain, transport });
    const tx = await payerClient.sendTransaction({
      to: owner.address,
      value: 0n,
      authorizationList: [authorization],
    });
    const receipt = await client.waitForTransactionReceipt({
      hash: tx,
      timeout: 45_000,
      checkReplacement: false,
    });
    const ownerState = await snapshot(owner.address);
    if (
      receipt.status !== "success" ||
      ownerState.native !== "0" ||
      (await client.getCode({ address: owner.address }))?.toLowerCase() !== designation
    )
      throw new Error("Delegation was not verified");
    console.log(
      JSON.stringify({
        chainId,
        owner: owner.address,
        payer: payer.address,
        setupTransaction: tx,
        ownerState,
      }),
    );
    process.exit(0);
  } finally {
    prompts.close();
  }
}

const apiUrl = process.env.ITEM143_PILOT_VENUE;
const paymasterPin = process.env.ITEM143_VERIFYING_PAYMASTER;
if (!apiUrl || !paymasterPin)
  throw new Error(
    "Set the isolated pilot venue URL and independently approved verifying-paymaster pin",
  );
const venue = new URL(apiUrl);
if (
  venue.origin !== apiUrl ||
  (venue.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(venue.hostname))
) {
  throw new Error("Use an HTTPS pilot venue origin or a loopback origin");
}
if (["api.xochi.fi", "xochi.fi"].includes(venue.hostname))
  throw new Error("Production venue is outside the pilot");
const paymaster = getAddress(paymasterPin);
type Checkpoint = {
  hash: Hex;
  sender: Address;
  action: "send" | "approve_permit2";
  amount: string;
  recipient?: Address;
  before: Awaited<ReturnType<typeof snapshot>>;
};
const saved =
  mode === "status" && value ? (JSON.parse(readFileSync(value, "utf8")) as Checkpoint) : null;
if (mode === "status" && (!saved || !isHash(saved.hash)))
  throw new Error("Provide the pending checkpoint file");
const actionName = saved?.action ?? (mode === "approve" ? "approve_permit2" : "send");
const useOwner = actionName === "approve_permit2" || (saved && saved.sender === owner.address);
if (useOwner && !delegated)
  throw new Error("The owner needs the canonical pre-existing Simple7702Account delegation");
const sender = useOwner ? owner.address : derived;
if (saved && saved.sender !== sender) throw new Error("Checkpoint sender does not match this key");

const connectorId = "item143-local-testnet";
const connector = createConnector(() => ({
  id: connectorId,
  name: "Robinhood Testnet",
  type: "local",
  connect: (async ({ withCapabilities } = {}) => ({
    accounts: withCapabilities ? [{ address: sender, capabilities: {} }] : [sender],
    chainId,
  })) as ReturnType<CreateConnectorFn>["connect"],
  disconnect: async () => {},
  getAccounts: async () => [sender],
  getChainId: async () => chainId,
  getProvider: async () => ({
    request: async ({ method }: { method: string }) => {
      if (method === "eth_accounts") return [sender];
      if (method === "eth_chainId") return numberToHex(chainId);
      throw new Error("This testnet connector does not submit ordinary transactions");
    },
  }),
  isAuthorized: async () => true,
  onAccountsChanged() {},
  onChainChanged() {},
  onDisconnect() {},
}));
const config = createConfig({
  chains: [chain],
  connectors: [connector],
  storage: null,
  multiInjectedProviderDiscovery: false,
  transports: { [chainId]: transport },
});

configureWidget({
  apiUrl,
  development: true,
  originSponsorshipTestnet: true,
  depositAttestationSigner: "",
  solverPin: { erc3009Allowlist: [], permit2Allowlist: [], requirePin: true },
  originSponsorship: {
    resolve(context) {
      if (
        context.chainId !== chainId ||
        context.connector.id !== connectorId ||
        context.sender !== sender
      )
        return null;
      return {
        profile: useOwner ? "simple_7702" : "simple_account",
        owner: owner.address,
        salt: 0n,
        paymaster,
        async signMessage(message) {
          await confirm(message);
          return owner.signMessage({ message });
        },
        async signOperation(action, hash) {
          await confirm(
            JSON.stringify({ chainId, sender, hash, ...action }, (_, field) =>
              typeof field === "bigint" ? field.toString() : field,
            ),
          );
          return owner.sign({ hash });
        },
      };
    },
  },
});
await connect(config, { connector: config.connectors[0] });
const active = getAccount(config);
const sponsorship = resolveOriginSponsorship(
  config,
  {
    connector: active.connector!,
    sender,
    chainId,
    action: actionName,
  },
  () => true,
);
if (!sponsorship) throw new Error("Pilot wallet adapter unavailable");

try {
  let checkpoint = saved;
  if (!checkpoint) {
    if (!value || !extra || !/^[1-9][0-9]*$/.test(value))
      throw new Error("Pass a positive atomic amount and a recipient or quote ID");
    const amount = BigInt(value);
    const action: OriginSponsorshipAction =
      mode === "send"
        ? { action: "send", token, amount, recipient: getAddress(extra) }
        : { action: "approve_permit2", token, amount, quoteId: extra };
    if (action.action === "send" && action.recipient === sender)
      throw new Error("Choose a distinct recipient");
    const recipient = action.action === "send" ? action.recipient : undefined;
    const before = await snapshot(sender, recipient);
    console.log(JSON.stringify({ chainId, sender, owner: owner.address, token, before }));
    if (
      BigInt(before.native) !== 0n ||
      BigInt(before.usdg) < amount ||
      (action.action === "approve_permit2" && BigInt(before.allowance) !== 0n)
    ) {
      throw new Error(
        "Expected sufficient USDG, zero native balance and (for approval) zero existing allowance",
      );
    }
    const checkpointPath = `${keyFile}.${actionName}.checkpoint.json`;
    await sponsorship.submit(action, (hash) => {
      checkpoint = { hash, sender, action: actionName, amount: value, recipient, before };
      writeFileSync(checkpointPath, JSON.stringify(checkpoint), { flag: "wx", mode: 0o600 });
      console.log(JSON.stringify({ checkpointPath, userOpHash: hash }));
    });
  }
  if (!checkpoint) throw new Error("No saved UserOperation");
  const details: Checkpoint = checkpoint;
  const status = await sponsorship.wait(details.hash);
  if (!status?.success)
    throw new Error("Successful receipt unavailable; retain the checkpoint for status");
  const transaction = await client.getTransactionReceipt({ hash: status.hash });
  const operation = parseEventLogs({
    abi: userOpEvent,
    logs: transaction.logs.filter((log) => log.address.toLowerCase() === entryPoint.toLowerCase()),
  }).find(
    ({ args }) =>
      args.userOpHash === details.hash &&
      args.sender.toLowerCase() === sender.toLowerCase() &&
      args.paymaster.toLowerCase() === paymaster.toLowerCase() &&
      args.success,
  );
  if (transaction.status !== "success" || !operation)
    throw new Error("RPC receipt lacks the matching successful sponsored EntryPoint event");
  const tokenLogs = transaction.logs.filter(
    (log) => log.address.toLowerCase() === token.toLowerCase(),
  );
  const tokenEvent =
    details.action === "send"
      ? parseEventLogs({ abi: erc20Abi, eventName: "Transfer", logs: tokenLogs }).some(
          ({ args }) =>
            args.from.toLowerCase() === sender.toLowerCase() &&
            args.to.toLowerCase() === details.recipient?.toLowerCase() &&
            args.value === BigInt(details.amount),
        )
      : parseEventLogs({ abi: erc20Abi, eventName: "Approval", logs: tokenLogs }).some(
          ({ args }) =>
            args.owner.toLowerCase() === sender.toLowerCase() &&
            args.spender.toLowerCase() === permit2.toLowerCase() &&
            args.value === BigInt(details.amount),
        );
  if (!tokenEvent) throw new Error("RPC receipt lacks the expected USDG event");
  const after = await snapshot(sender, details.recipient);
  const amount = BigInt(details.amount);
  const deltaMatches =
    details.action === "send"
      ? BigInt(details.before.usdg) - BigInt(after.usdg) === amount &&
        BigInt(after.recipientUsdg!) - BigInt(details.before.recipientUsdg!) === amount
      : BigInt(after.allowance) === amount && after.usdg === details.before.usdg;
  if (after.native !== "0" || !deltaMatches)
    throw new Error("Post-transaction balances or allowance do not match the sponsored operation");
  console.log(
    JSON.stringify(
      {
        chainId,
        ...details,
        after,
        transactionHash: status.hash,
        blockNumber: transaction.blockNumber.toString(),
        entryPoint,
        paymaster,
        paidGasWei: operation.args.actualGasCost.toString(),
      },
      null,
      2,
    ),
  );
} finally {
  prompts.close();
}
