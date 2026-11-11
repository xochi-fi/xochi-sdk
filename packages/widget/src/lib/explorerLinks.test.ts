import { describe, it, expect } from "vitest";
import { swapExplorerLinks } from "./explorerLinks.js";

describe("swapExplorerLinks", () => {
  it("links each leg to the chain it settled on for a cross-chain swap", () => {
    // Base (8453) deposit -> Arbitrum (42161) fill. The deposit hash lives on
    // basescan, the fill hash on arbiscan. Same string on the wrong domain is
    // the bug this pins against.
    const links = swapExplorerLinks({
      fromChainId: 8453,
      toChainId: 42161,
      txHash: "0xdeposit",
      receivingTxHash: "0xfill",
    });
    expect(links.source).toBe("https://basescan.org/tx/0xdeposit");
    expect(links.destination).toBe("https://arbiscan.io/tx/0xfill");
  });

  it("omits the destination link for a same-chain swap", () => {
    const links = swapExplorerLinks({
      fromChainId: 8453,
      toChainId: 8453,
      txHash: "0xdeposit",
      receivingTxHash: "0xfill",
    });
    expect(links.source).toBe("https://basescan.org/tx/0xdeposit");
    expect(links.destination).toBeNull();
  });

  it("links a lone settlement hash to the destination chain (Riddler's fill)", () => {
    // No explicit receivingTxHash: Riddler reports the cross-chain fill in
    // `tx_hash`, and that hash lives on the DESTINATION chain (arbiscan), not the
    // origin. Linking it to basescan was the wrong-chain bug.
    const links = swapExplorerLinks({
      fromChainId: 8453,
      toChainId: 42161,
      txHash: "0xfillonly",
      receivingTxHash: null,
    });
    expect(links.source).toBe("https://arbiscan.io/tx/0xfillonly");
    expect(links.destination).toBeNull();
  });

  it("links a refund's settlement hash to the origin chain", () => {
    // A refund returns funds to where they came from, so the tx is on the origin
    // chain even without a separate fill hash.
    const links = swapExplorerLinks({
      fromChainId: 8453,
      toChainId: 42161,
      txHash: "0xrefund",
      receivingTxHash: null,
      isRefunded: true,
    });
    expect(links.source).toBe("https://basescan.org/tx/0xrefund");
    expect(links.destination).toBeNull();
  });

  it("returns a null source when no deposit hash exists", () => {
    const links = swapExplorerLinks({
      fromChainId: 8453,
      toChainId: 42161,
      txHash: null,
      receivingTxHash: "0xfill",
    });
    expect(links.source).toBeNull();
    expect(links.destination).toBe("https://arbiscan.io/tx/0xfill");
  });

  // --- Riddler #632: explicit settlement receipt (the public cross-chain fill the
  // legacy heuristic missed, since Riddler leaves receivingTxHash null for it). ---

  it("keys the destination link off settlementTxHash/settlementChainId, not inference", () => {
    // Public cross-chain fill: Riddler returns the receipt on chain 1 (Ethereum)
    // with receivingTxHash null. The legacy path would have produced no
    // destination link; the #632 path links it explicitly.
    const links = swapExplorerLinks({
      fromChainId: 8453,
      toChainId: 42161,
      txHash: "0xorigin",
      receivingTxHash: null,
      settlementTxHash: "0xreceipt",
      settlementChainId: 1,
    });
    expect(links.source).toBe("https://basescan.org/tx/0xorigin");
    expect(links.destination).toBe("https://etherscan.io/tx/0xreceipt");
  });

  it("omits the source when the origin leg equals the settlement receipt", () => {
    // Same-chain / fast fill: tx_hash and settlementTxHash are the same tx.
    const links = swapExplorerLinks({
      fromChainId: 8453,
      toChainId: 8453,
      txHash: "0xsame",
      receivingTxHash: null,
      settlementTxHash: "0xsame",
      settlementChainId: 8453,
    });
    expect(links.source).toBeNull();
    expect(links.destination).toBe("https://basescan.org/tx/0xsame");
  });

  it("ignores the settlement receipt for a refund (its tx is on the origin chain)", () => {
    // The worker defaults settlementChainId to to_chain_id; a refund must not use
    // it, or the refund link would point at the destination explorer.
    const links = swapExplorerLinks({
      fromChainId: 8453,
      toChainId: 42161,
      txHash: "0xrefund",
      receivingTxHash: null,
      settlementTxHash: "0xrefund",
      settlementChainId: 42161,
      isRefunded: true,
    });
    expect(links.source).toBe("https://basescan.org/tx/0xrefund");
    expect(links.destination).toBeNull();
  });

  it("falls back to inference when settlementChainId is an unrenderable chain", () => {
    // Riddler adds chains on its own cadence; an id the UI can't map must not
    // produce a dead `href=""`. Fall back to the legacy inference instead.
    const links = swapExplorerLinks({
      fromChainId: 8453,
      toChainId: 42161,
      txHash: "0xfill",
      receivingTxHash: null,
      settlementTxHash: "0xfill",
      settlementChainId: 999999 as never,
    });
    // Legacy branch: no receivingTxHash and not refunded -> tx_hash is inferred to
    // be the destination fill and linked on to_chain_id (arbiscan), never a dead
    // link on the unknown 999999 explorer.
    expect(links.source).toBe("https://arbiscan.io/tx/0xfill");
    expect(links.destination).toBeNull();
  });
});
