// @vitest-environment jsdom

import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { createConnector } from "wagmi";
import { mock } from "wagmi/connectors";
import { arbitrum, base } from "wagmi/chains";
import {
  encodeFunctionData,
  erc20Abi,
  hashTypedData,
  parseAbi,
  recoverAddress,
  toHex,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  computeIntentIdHash,
  computeUserOpHash,
  ENTRYPOINT_V08_ADDRESS,
  PERMIT2_ADDRESS,
  PERMIT2_TYPES,
} from "@xochi/signer";
import { ROBINHOOD_CHAIN_ID } from "@xochi/client";
import { configureWidget } from "../../config.js";
import { useIntent } from "../../hooks/useIntent.js";
import { intentAPI } from "../../lib/intentAPI.js";
import { quoteWire, USDC_BASE, WETH_ARBITRUM } from "../../test/intentHarness.js";
import { usePermit } from "../../hooks/usePermit.js";
import { listLocalSends } from "../../lib/localSends.js";
import { SIMPLE_7702_DELEGATE, type OriginSponsorshipAction } from "../../lib/originSponsorship.js";
import { WAIT, testBudget } from "../../test/waitBudget.js";
import { Trade } from "../Trade.js";
import { findTokenBySymbol } from "../trade/config.js";
import { FULL_LOOK } from "../trade/embedParams.js";
import {
  apiStub,
  harnessReceipts,
  makeTestConfig,
  renderTrade,
  TEST_ACCOUNT,
} from "../trade/harness.js";

vi.mock("../../lib/recipient/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/recipient/index.js")>()),
  resolveRecipient: async (input: string) => ({
    status: "resolved",
    recipient: { kind: "address", address: input, input },
  }),
}));

vi.setConfig({ testTimeout: testBudget({ renders: 2, waits: 5 }) });

const owner = privateKeyToAccount(`0x${"12".repeat(32)}`);
const spender = "0x3333333333333333333333333333333333333333";
const intentId = "11111111-1111-1111-1111-111111111111";
const quoteId = "22222222-2222-2222-2222-222222222222";
const recipient = "0x2222222222222222222222222222222222222222";
const paymaster = "0x888888888888Ec68A58AB8094Cc1AD20Ba3D2402";
const transaction = `0x${"ab".repeat(32)}` as const;
const signMessage = vi.fn((message: string) => owner.signMessage({ message }));
const signOperation = vi.fn((_action: OriginSponsorshipAction, hash: Hex) => owner.sign({ hash }));
configureWidget({
  apiUrl: "https://api.xochi.fi",
  depositAttestationSigner: "",
  solverPin: { erc3009Allowlist: [], permit2Allowlist: [spender], requirePin: true },
  originSponsorship: {
    resolve: ({ connector, sender }) => {
      if (connector.id !== "testSimpleAccount") return null;
      const profile = sender === TEST_ACCOUNT ? "simple_account" : "simple_7702";
      return { profile, owner: owner.address, salt: 0n, paymaster, signMessage, signOperation };
    },
  },
});

const accountAbi = parseAbi(["function execute(address,uint256,bytes)"]);
const factoryAbi = parseAbi(["function getAddress(address,uint256) view returns (address)"]);
const getAddressSelector = encodeFunctionData({
  abi: factoryAbi,
  functionName: "getAddress",
  args: [owner.address, 0n],
}).slice(0, 10);

function fixture({
  loseSubmit = false,
  wrongCall = false,
  supported = true,
  delegated = false,
} = {}) {
  const sender = delegated ? owner.address : TEST_ACCOUNT;
  let allowance = 0n;
  let opHash: string | undefined;
  let action: string | undefined;
  const prepares: Array<Record<string, unknown>> = [];
  const submits: Array<Record<string, unknown>> = [];
  const statuses: Array<Record<string, unknown>> = [];
  const walletCalls: string[] = [];
  const typedSignatures: { type: string; digest: Hex; signature: Hex }[] = [];
  const executions: Record<string, unknown>[] = [];
  const fallback = apiStub(
    {},
    {
      onWalletRpc: (method) => walletCalls.push(method),
      walletResults: { eth_sendTransaction: transaction },
    },
  );
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
    if (body.method === "eth_signTypedData_v4") {
      expect(body.params[0].toLowerCase()).toBe(sender.toLowerCase());
      const typed = JSON.parse(body.params[1]);
      const digest = hashTypedData(typed);
      const signature = await owner.sign({ hash: digest });
      typedSignatures.push({ type: typed.primaryType, digest, signature });
      return Response.json({ jsonrpc: "2.0", id: body.id, result: signature });
    }
    if (url.pathname === "/api/intent/quote") {
      const deadline = Math.floor(Date.now() / 1_000) + 300;
      return Response.json(
        quoteWire({
          intent_id: intentId,
          quote_id: quoteId,
          payment_method: "permit2",
          eip712: {
            domain: { name: "Xochi", version: "3", chainId: base.id },
            types: { XochiIntent: [{ name: "toAmount", type: "uint256" }] },
            primaryType: "XochiIntent",
            message: {
              wallet: sender,
              fromChainId: base.id,
              toChainId: arbitrum.id,
              fromToken: USDC_BASE,
              toToken: WETH_ARBITRUM,
              fromAmount: body.from_amount,
              toAmount: "500000000000000",
              recipient: sender,
              settlementPreference: "public",
              deadline,
            },
          },
          pull_authorization: {
            domain: { name: "Permit2", chainId: base.id, verifyingContract: PERMIT2_ADDRESS },
            types: PERMIT2_TYPES,
            primaryType: "PermitWitnessTransferFrom",
            message: {
              permitted: { token: USDC_BASE, amount: body.from_amount },
              spender,
              nonce: "0",
              deadline,
              witness: { orderId: computeIntentIdHash(intentId) },
            },
          },
        }),
      );
    }
    if (url.pathname === "/api/intent/execute") {
      executions.push(body);
      const response = Response.json({ success: true, intent_id: intentId, status: "executing" });
      Object.defineProperty(response, "url", { value: url.href });
      return response;
    }
    if (url.pathname === "/api/auth/wallet/challenge") {
      expect(body.wallet).toBe(owner.address.toLowerCase());
      return Response.json({ message: "Owner SIWE", nonce: "fixture" });
    }
    if (url.pathname === "/api/auth/wallet/verify") {
      expect(body.signature).toBe(await owner.signMessage({ message: "Owner SIWE" }));
      return Response.json({ token: "owner-session", wallet: owner.address });
    }
    if (!url.pathname.startsWith("/api/origin-sponsorship/")) return fallback(input, init);
    if (url.pathname.endsWith("/capabilities"))
      return Response.json({
        chain_ids: supported ? [ROBINHOOD_CHAIN_ID, base.id] : [],
        approve_permit2_chain_ids: supported ? [base.id] : [],
      });
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer owner-session");
    if (url.pathname.endsWith("/prepare")) {
      prepares.push(body);
      expect(body.sender.toLowerCase()).toBe(sender.toLowerCase());
      expect(body.owner).toBe(owner.address);
      action = body.action;
      const inner =
        action === "send"
          ? encodeFunctionData({
              abi: erc20Abi,
              functionName: "transfer",
              args: [body.recipient, BigInt(body.amount) + (wrongCall ? 1n : 0n)],
            })
          : encodeFunctionData({
              abi: erc20Abi,
              functionName: "approve",
              args: [PERMIT2_ADDRESS, BigInt(body.amount)],
            });
      const op = {
        sender,
        nonce: "0x0",
        callData: encodeFunctionData({
          abi: accountAbi,
          functionName: "execute",
          args: [body.token, 0n, inner],
        }),
        callGasLimit: "0x10000",
        verificationGasLimit: "0x10000",
        preVerificationGas: "0x10000",
        maxFeePerGas: "0x1",
        maxPriorityFeePerGas: "0x1",
        paymaster,
        paymasterVerificationGasLimit: "0x10000",
        paymasterPostOpGasLimit: "0x10000",
        paymasterData: "0x1234",
      };
      opHash = computeUserOpHash(op, ENTRYPOINT_V08_ADDRESS, body.chain_id);
      return Response.json({
        user_operation: op,
        user_op_hash: opHash,
        entry_point: ENTRYPOINT_V08_ADDRESS,
      });
    }
    if (url.pathname.endsWith("/submit")) {
      submits.push(body);
      expect(body.user_op_hash).toBe(opHash);
      expect(body.signature).toBe(await owner.sign({ hash: body.user_op_hash }));
      if (loseSubmit) throw new TypeError("Submit response lost");
      return Response.json({ user_op_hash: opHash });
    }
    if (url.pathname.endsWith("/status")) {
      statuses.push(body);
      expect(body.user_op_hash).toBe(opHash);
      if (action === "approve_permit2") allowance = BigInt(String(prepares[0].amount));
      return Response.json({ status: "succeeded", transaction_hash: transaction });
    }
    throw new Error(`Unexpected sponsorship request ${url.pathname}`);
  });
  const mobile = mock({ accounts: [sender], features: { reconnect: true } });
  const connector = createConnector((config) => ({
    ...mobile(config),
    id: "testSimpleAccount",
    type: "walletConnect",
  }));
  const config = makeTestConfig(10_000_000n, false, undefined, connector, (method, params) => {
    if (method === "eth_getCode" && delegated) return `0xef0100${SIMPLE_7702_DELEGATE.slice(2)}`;
    if (method !== "eth_call" || !Array.isArray(params)) return;
    const calldata: string | undefined = params[0]?.data;
    if (calldata?.startsWith(getAddressSelector)) return toHex(BigInt(TEST_ACCOUNT), { size: 32 });
    if (calldata?.startsWith("0xdd62ed3e")) return toHex(allowance, { size: 32 });
  });
  return { config, prepares, submits, statuses, walletCalls, typedSignatures, executions };
}

async function confirmSend(
  chainId: typeof ROBINHOOD_CHAIN_ID | typeof base.id,
  symbol: string,
  config?: ReturnType<typeof makeTestConfig>,
) {
  window.history.replaceState({}, "", `/?fromChain=${chainId}&sell=${symbol}`);
  await renderTrade(<Trade look={FULL_LOOK} />, {
    connected: true,
    config,
    walletChainId: chainId,
    tokenBalance: 10_000_000n,
  });
  fireEvent.click(screen.getByRole("tab", { name: /^Send/ }));
  const form = within(screen.getByRole("form", { name: "Send" }));
  fireEvent.change(form.getByLabelText("Pay from"), { target: { value: String(chainId) } });
  fireEvent.change(form.getByLabelText("Asset"), {
    target: { value: findTokenBySymbol(chainId, symbol)!.address },
  });
  await form.findByText(`Balance 10 ${symbol}`, {}, WAIT);
  fireEvent.change(form.getByLabelText("Amount"), { target: { value: "1" } });
  fireEvent.change(form.getByLabelText("To"), { target: { value: recipient } });
  await form.findByText("Public", {}, WAIT);
  fireEvent.click(form.getByRole("button", { name: "Send" }));
  const review = await screen.findByRole("region", { name: "Review send" }, WAIT);
  expect(signMessage).not.toHaveBeenCalled();
  expect(signOperation).not.toHaveBeenCalled();
  fireEvent.click(within(review).getByRole("button", { name: "Confirm in wallet" }));
}

afterEach(() => {
  cleanup();
  harnessReceipts.clear();
  vi.unstubAllGlobals();
  signOperation.mockClear();
  signMessage.mockClear();
  localStorage.clear();
  sessionStorage.clear();
  intentAPI.clearQuoteCache();
});

it("uses the mobile signer for Robinhood USDG Send with zero native balance and recovers a lost submit by hash", async () => {
  const { config, prepares, submits, statuses, walletCalls } = fixture({ loseSubmit: true });
  expect(
    await config
      .getClient({ chainId: ROBINHOOD_CHAIN_ID })
      .request({ method: "eth_getBalance", params: [TEST_ACCOUNT, "latest"] }),
  ).toBe("0x0");
  await confirmSend(ROBINHOOD_CHAIN_ID, "USDG", config);
  await screen.findByRole("heading", { name: "Transfer status unknown" }, WAIT);
  fireEvent.click(screen.getByRole("button", { name: "Check existing transfer" }));
  await screen.findByRole("heading", { name: "Sent" }, WAIT);
  expect(prepares).toEqual([
    expect.objectContaining({
      action: "send",
      chain_id: ROBINHOOD_CHAIN_ID,
      amount: "1000000",
      recipient,
      token: findTokenBySymbol(ROBINHOOD_CHAIN_ID, "USDG")!.address,
    }),
  ]);
  expect(signOperation).toHaveBeenCalledTimes(1);
  expect(submits).toHaveLength(1);
  expect(statuses).toEqual([
    { chain_id: ROBINHOOD_CHAIN_ID, user_op_hash: submits[0].user_op_hash },
  ]);
  expect(walletCalls).not.toContain("eth_sendTransaction");
  expect(listLocalSends(TEST_ACCOUNT)[0]).toMatchObject({ id: transaction, status: "completed" });
});

const baseToken = "0x4200000000000000000000000000000000000006";
it("sponsors the exact first approval in the Base mobile swap flow and submits both owner signatures", async () => {
  const { config, prepares, submits, walletCalls, typedSignatures, executions } = fixture({
    delegated: true,
  });
  function Swap() {
    const intent = useIntent({
      fromChainId: base.id,
      toChainId: arbitrum.id,
      fromToken: USDC_BASE,
      toToken: WETH_ARBITRUM,
      settlementPreference: "public",
      settlementAuthorized: true,
    });
    return (
      <>
        <button onClick={() => intent.requestQuote("1000000")}>Quote</button>
        {intent.status === "quoted" && <button onClick={intent.sign}>Confirm</button>}
        {intent.awaitingPull && <button onClick={intent.signPull}>Sign pull</button>}
      </>
    );
  }
  await renderTrade(<Swap />, { config, connected: true, walletChainId: base.id });
  fireEvent.click(screen.getByRole("button", { name: "Quote" }));
  fireEvent.click(await screen.findByRole("button", { name: "Confirm" }, WAIT));
  const pull = await screen.findByRole("button", { name: "Sign pull" }, WAIT);
  expect(typedSignatures.map(({ type }) => type)).toEqual(["XochiIntent"]);
  expect(submits).toHaveLength(0);
  await act(async () => fireEvent.click(pull));
  await waitFor(() => expect(executions).toHaveLength(1), WAIT);
  expect(prepares).toEqual([
    expect.objectContaining({
      action: "approve_permit2",
      chain_id: base.id,
      sender: owner.address,
      owner: owner.address,
      token: USDC_BASE,
      quote_id: quoteId,
      amount: "1000000",
    }),
  ]);
  expect(submits).toHaveLength(1);
  expect(walletCalls).not.toContain("eth_sendTransaction");
  expect(typedSignatures.map(({ type }) => type)).toEqual([
    "XochiIntent",
    "PermitWitnessTransferFrom",
  ]);
  for (const { digest, signature } of typedSignatures)
    expect(await recoverAddress({ hash: digest, signature })).toBe(owner.address);
  expect(executions[0]).toMatchObject({
    signature: typedSignatures[0].signature,
    pull_signature: typedSignatures[1].signature,
  });
});

it("refuses Permit2 approval before prompting for a factory SimpleAccount", async () => {
  const { config, prepares, submits, walletCalls } = fixture();
  const approval = vi.fn();
  function Approval() {
    const permit = usePermit({
      token: baseToken,
      chainId: base.id,
      amount: "100",
      quoteId,
      servedMethod: "permit2",
    });
    return (
      <button onClick={() => void permit.ensureApproval(100n).then(approval)}>
        {permit.approval}
      </button>
    );
  }
  await renderTrade(<Approval />, { config, connected: true, walletChainId: base.id });
  fireEvent.click(await screen.findByRole("button", { name: "required" }, WAIT));
  await waitFor(() => expect(approval).toHaveBeenCalledWith(false), WAIT);
  expect(prepares).toHaveLength(0);
  expect(submits).toHaveLength(0);
  expect(walletCalls).not.toContain("eth_sendTransaction");
});

it("leaves an unsupported wallet on its ordinary wallet path", async () => {
  const { prepares, submits, walletCalls } = fixture();
  harnessReceipts.set(transaction, "success");
  await confirmSend(base.id, "USDC");
  await screen.findByRole("region", { name: "Send submitted" }, WAIT);
  expect(prepares).toHaveLength(0);
  expect(submits).toHaveLength(0);
  expect(walletCalls.filter((method) => method === "eth_sendTransaction")).toHaveLength(1);
});

it.each([{ wrongCall: true }, { supported: false }])(
  "stops before signing or sending when sponsorship is invalid or unavailable (%o)",
  async (options) => {
    const { config, submits, walletCalls } = fixture(options);
    await confirmSend(base.id, "USDC", config);
    await screen.findByRole("button", { name: "Confirm in wallet" }, WAIT);
    expect(signOperation).not.toHaveBeenCalled();
    expect(submits).toHaveLength(0);
    expect(walletCalls).not.toContain("eth_sendTransaction");
  },
);
