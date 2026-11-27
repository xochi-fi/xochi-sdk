// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useAddressSend } from "./useAddressSend.js";
import { encodeFunctionData, erc20Abi, zeroAddress } from "viem";
import { readSendAttempt } from "../../lib/localSends.js";
import { sendAssets, sendTokens } from "./addressSend.js";

const wallet = vi.hoisted(() => ({
  calls: 0,
  native: false,
  nativeArgs: [] as unknown[],
  refused: false,
  readable: false,
  mismatch: false,
  reserved: false,
  receiptAvailable: false,
  oldBlock: false,
  returnedHash: false,
}));
vi.mock("wagmi", () => ({
  useConfig: () => ({ getClient: () => ({}) }),
  useAccount: () => ({
    address: "0x1111111111111111111111111111111111111111",
    chainId: 1,
    connector: { uid: "test" },
  }),
}));
vi.mock("wagmi/actions", () => ({
  switchChain: async () => {},
  sendTransaction: async (...args: unknown[]) => {
    wallet.calls++;
    wallet.nativeArgs = args;
    throw new Error("Response lost");
  },
  writeContract: async () => {
    wallet.calls++;
    wallet.reserved = readSendAttempt("0x1111111111111111111111111111111111111111") !== null;
    if (wallet.refused) throw { code: 4001 };
    if (wallet.returnedHash) return HASH;
    throw new Error("Response lost");
  },
  getTransactionReceipt: async () => {
    if (!wallet.receiptAvailable) throw new Error("Unavailable");
    return { status: "success", blockHash: HASH };
  },
  getBlock: async () => ({
    timestamp: wallet.oldBlock ? 1n : BigInt(Math.floor(Date.now() / 1000)),
  }),
  getTransaction: async () => {
    if (wallet.readable)
      return {
        from: "0x1111111111111111111111111111111111111111",
        to: wallet.native ? "0x2222222222222222222222222222222222222222" : sendTokens(1)[0].address,
        value: wallet.native ? (wallet.mismatch ? 200n : 100n) : 0n,
        input: wallet.native
          ? "0x"
          : encodeFunctionData({
              abi: erc20Abi,
              functionName: "transfer",
              args: ["0x2222222222222222222222222222222222222222", wallet.mismatch ? 200n : 100n],
            }),
      };
    throw new Error("Unavailable");
  },
}));
vi.mock("viem/actions", () => ({
  waitForTransactionReceipt: async () => {
    throw new Error("Unavailable");
  },
}));

const HASH = `0x${"ab".repeat(32)}`;
afterEach(() => {
  cleanup();
  localStorage.clear();
  wallet.calls = 0;
  wallet.native = false;
  wallet.nativeArgs = [];
  wallet.refused = false;
  wallet.readable = false;
  wallet.mismatch = false;
  wallet.reserved = false;
  wallet.receiptAvailable = false;
  wallet.oldBlock = false;
  wallet.returnedHash = false;
});
it("blocks another wallet call after a lost broadcast response, including remount", async () => {
  const first = renderHook(() => useAddressSend());
  act(() =>
    first.result.current.review({
      chainId: 1,
      token: sendTokens(1)[0],
      amount: 100000000n,
      recipient: "0x2222222222222222222222222222222222222222",
    }),
  );
  await act(() => first.result.current.approve());
  expect(first.result.current.phase.step).toBe("in_doubt");
  await act(() => first.result.current.approve());
  first.unmount();
  const restored = renderHook(() => useAddressSend());
  expect(restored.result.current.phase.step).toBe("in_doubt");
  await act(() => restored.result.current.approve());
  expect(wallet.calls).toBe(1);
});

it("persists the sanitized reservation before crossing the wallet boundary", async () => {
  const hook = renderHook(() => useAddressSend());
  act(() =>
    hook.result.current.review({
      chainId: 1,
      token: sendTokens(1)[0],
      amount: 100n,
      recipient: "0x2222222222222222222222222222222222222222",
    }),
  );
  await act(() => hook.result.current.approve());
  const attempt = readSendAttempt("0x1111111111111111111111111111111111111111");
  expect(attempt?.data.amount).toBe("100");
  expect(wallet.reserved).toBe(true);
  expect(JSON.stringify(attempt)).not.toContain("Response lost");
  act(() => hook.result.current.reset());
  expect(hook.result.current.phase.step).toBe("in_doubt");
});

it("does not call the wallet if durable storage is unavailable", async () => {
  const hook = renderHook(() => useAddressSend());
  act(() =>
    hook.result.current.review({
      chainId: 1,
      token: sendTokens(1)[0],
      amount: 100n,
      recipient: "0x2222222222222222222222222222222222222222",
    }),
  );
  const unavailable = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("Unavailable");
  });
  await act(() => hook.result.current.approve());
  unavailable.mockRestore();
  expect(wallet.calls).toBe(0);
  expect(hook.result.current.phase.step).toBe("blocked");
});

const order = () => ({
  chainId: 1,
  token: sendTokens(1)[0],
  amount: 100n,
  recipient: "0x2222222222222222222222222222222222222222" as const,
});
it("returns to review only for an explicit wallet refusal", async () => {
  wallet.refused = true;
  const hook = renderHook(() => useAddressSend());
  act(() => hook.result.current.review(order()));
  await act(() => hook.result.current.approve());
  expect(hook.result.current.phase.step).toBe("review");
  expect(readSendAttempt("0x1111111111111111111111111111111111111111")).toBeNull();
});
it("reconciles only the exact transfer without another wallet call", async () => {
  const hook = renderHook(() => useAddressSend());
  act(() => hook.result.current.review(order()));
  await act(() => hook.result.current.approve());
  const hash = HASH;
  await act(() => hook.result.current.reconcile(hash));
  expect(hook.result.current.phase.step).toBe("in_doubt");
  wallet.readable = true;
  wallet.mismatch = true;
  await act(() => hook.result.current.reconcile(hash));
  expect(hook.result.current.phase.step).toBe("in_doubt");
  wallet.mismatch = false;
  wallet.receiptAvailable = true;
  await act(() => hook.result.current.reconcile(hash));
  expect(hook.result.current.phase).toMatchObject({ step: "sent", outcome: "confirmed", hash });
  expect(wallet.calls).toBe(1);
  expect(readSendAttempt("0x1111111111111111111111111111111111111111")).toBeNull();
});

it("preserves an attached candidate across remount while its receipt is unavailable", async () => {
  const first = renderHook(() => useAddressSend());
  act(() => first.result.current.review(order()));
  await act(() => first.result.current.approve());
  wallet.readable = true;
  await act(() => first.result.current.reconcile(HASH));
  first.unmount();

  const restored = renderHook(() => useAddressSend());
  expect(restored.result.current.phase).toMatchObject({
    step: "in_doubt",
    attempt: { candidateHash: HASH },
  });
  wallet.receiptAvailable = true;
  wallet.oldBlock = true;
  await act(() => restored.result.current.reconcile(HASH));
  expect(restored.result.current.phase.step).toBe("in_doubt");
  expect(wallet.calls).toBe(1);
});

it("recovers the wallet-returned hash after a receipt read fails", async () => {
  wallet.returnedHash = true;
  const first = renderHook(() => useAddressSend());
  act(() => first.result.current.review(order()));
  await act(() => first.result.current.approve());
  first.unmount();

  const restored = renderHook(() => useAddressSend());
  expect(restored.result.current.phase).toMatchObject({
    step: "in_doubt",
    attempt: { hash: HASH },
  });
  wallet.readable = true;
  wallet.receiptAvailable = true;
  await act(() => restored.result.current.reconcile(""));
  expect(restored.result.current.phase).toMatchObject({
    step: "sent",
    outcome: "confirmed",
    hash: HASH,
  });
  expect(wallet.calls).toBe(1);
});

it("uses the ordinary wallet for native transfers and restores the exact native value", async () => {
  wallet.native = true;
  const first = renderHook(() => useAddressSend());
  const transfer = order();
  const token = sendAssets(1).find((asset) => asset.address === zeroAddress)!;
  act(() => first.result.current.review({ ...transfer, token }));
  await act(() => first.result.current.approve());
  expect(wallet.nativeArgs[1]).toMatchObject({ to: transfer.recipient, value: 100n, chainId: 1 });
  first.unmount();
  const restored = renderHook(() => useAddressSend());
  expect(restored.result.current.phase).toMatchObject({ step: "in_doubt", order: { token } });
  wallet.readable = true;
  wallet.receiptAvailable = true;
  wallet.mismatch = true;
  await act(() => restored.result.current.reconcile(HASH));
  expect(restored.result.current.phase.step).toBe("in_doubt");
  wallet.mismatch = false;
  await act(() => restored.result.current.reconcile(HASH));
  expect(restored.result.current.phase).toMatchObject({ step: "sent", outcome: "confirmed" });
  expect(wallet.calls).toBe(1);
});
