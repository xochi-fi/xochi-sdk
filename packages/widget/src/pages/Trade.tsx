/**
 * Trade -- the widget.
 *
 * The market swap card plus in-frame tabs at the card's width: Swap (the
 * card), Activity (holdings strip + transaction log) and Claims (private
 * receiving). No site chrome: the widget is served alone, framed by its host
 * (xochi-fi/xochi-widget#20). Most protocol traffic is agents (via the MCP /
 * OpenAPI surface); this is the simple human path: connect a wallet, swap
 * cross-chain with public or stealth settlement, watch it settle.
 *
 * A host may drop parts of it (`look`, from the frame URL, xochi-widget#38):
 * `layout=swap` leaves the card without the tab row, so a stealth recipient
 * claims on the full widget in a tab of its own, opened on Claims.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useAccount, useConfig } from "wagmi";
import { watchAccount } from "wagmi/actions";
import { useOrderHistory } from "../hooks/useOrderHistory.js";
import { useWalletSession } from "../hooks/useWalletSession.js";
import { useLocalActivity } from "../hooks/useLocalActivity.js";
import { useAgentRegistry } from "../hooks/useAgentRegistry.js";
import { useAgentStream } from "../hooks/useAgentStream.js";
import { useStealthClaim } from "../hooks/useStealthClaim.js";
import { useTrustScore } from "../hooks/useTrustScore.js";
import { useSettlements } from "../hooks/useSettlements.js";
import { useCapabilities } from "../hooks/useCapabilities.js";
import { useToast } from "../components/Toast.js";
import { AssetsStrip } from "../components/AssetsStrip.js";
import { MobileSigningBanner } from "../components/MobileSigningBanner.js";
import { ActivityFeed } from "../components/ActivityFeed.js";
import { PrivacyPanel } from "../components/PrivacyPanel.js";
import { StealthClaims } from "../components/StealthClaims.js";
import { AccountChip } from "../components/AccountChip.js";
import { SwapPanel, type SwapPrefill } from "./trade/SwapPanel.js";
import { WidgetTabs, widgetTabIds, type WidgetTab, type WidgetTabId } from "./trade/WidgetTabs.js";
import { SHIELDED_ACCOUNTS_LIVE, STEALTH_CLAIM_LIVE } from "./trade/config.js";
import { CLAIMS_HASH, claimsPath, type EmbedLook } from "./trade/embedParams.js";
import {
  CLAIM_IN_XOCHI_APP,
  ClaimInXochiAppContext,
  WidgetTabsContext,
} from "../components/widgetTabsContext.js";
import { HOST_WALLET_ID } from "../wagmi.js";
import { reportSwapFailure } from "../lib/reportClient.js";
import { buildHistoryFailureRef } from "../lib/swapFlowPhase.js";
import { mergeHistorySwap } from "../lib/localActivity.js";
import {
  getWalletSessionAddress,
  getWalletSessionGeneration,
  getWalletToken,
  hasWalletSession,
} from "../lib/walletSession.js";
import { getTokenInfoForChain } from "@xochi/client";
import type { SwapActivityItem } from "../types/activity.js";
import { hostBridge } from "../lib/hostBridge.js";
import type { HostConnection, WalletUi } from "@xochi/widget-lib";

import { APP_VERSION } from "../config.js";

// Minimum spin time for the activity refresh button, so a fast or no-op refresh
// still gives visible feedback instead of flickering imperceptibly.
const MIN_REFRESH_SPIN_MS = 550;

type WalletUiConnection = Pick<HostConnection, "walletUi" | "requestConnect" | "onWalletUi">;

interface TradeProps {
  /**
   * What the frame shows and how tall it is (embedParams.ts). Required, so a
   * caller cannot silently drop the host's layout: EmbedApp passes the URL's.
   */
  look: EmbedLook;
  /** Connection override for focused host/standalone behavior tests. */
  hostConnection?: WalletUiConnection | null;
}

function useWalletUi(connection: WalletUiConnection | null): WalletUi {
  const [walletUi, setWalletUi] = useState<WalletUi>(() => connection?.walletUi() ?? "widget");

  useEffect(() => {
    if (connection === null) {
      setWalletUi("widget");
      return;
    }
    setWalletUi(connection.walletUi());
    return connection.onWalletUi(setWalletUi);
  }, [connection]);

  return walletUi;
}

export function Trade({ look, hostConnection = hostBridge }: TradeProps) {
  const { isConnected, address, connector } = useAccount();
  const config = useConfig();
  const { showToast } = useToast();
  const tabsShown = look.layout === "full";
  // A tabless frame on the host page's wallet cannot claim in a tab of its own.
  const claimInXochiApp = !tabsShown && connector?.id === HOST_WALLET_ID;
  const hostOwnsWalletUi = useWalletUi(hostConnection) === "host";
  const requestHostConnect = useCallback((): void => {
    hostConnection?.requestConnect();
  }, [hostConnection]);

  // Stealth receive (register + scan + claim). Gated behind STEALTH_CLAIM_LIVE
  // (the receive side), decoupled from the send toggle: when stealth SENDING is
  // paused (STEALTH_SETTLEMENT_LIVE off) recipients of existing stealth payments
  // must still be able to scan + claim, so this section stays live off the claim
  // flag. Keys come from the app-wide StealthProvider, so Setup, Register, Scan
  // and the swap panel's send side all act on the same instance.
  const stealthClaim = useStealthClaim();
  // Effective score: 0 while trust economics is off, so the panel shows Standard.
  const { trustScore, verifyState } = useTrustScore();
  // Server-owned trust launch flags (xochi#656); all off until the server says so.
  const { features } = useCapabilities();

  const {
    orders,
    isLoading: ordersLoading,
    error: ordersError,
    refresh: refreshOrders,
    hasMore: hasMoreOrders,
    loadMore: loadMoreOrders,
    needsSignIn: historyNeedsSignIn,
  } = useOrderHistory();

  // Sign-in-with-wallet is lazy: no prompt on connect. The Activity feed offers
  // an explicit "Sign in to view" affordance that calls this, then loads history.
  const { state: sessionState, ensureSession } = useWalletSession();
  const sessionWallet = getWalletSessionAddress() ?? undefined;

  // Claimable settlements, shared by the assets strip chip and the stealth panel
  // badge. Lifted here (rather than a second useSettlements inside each) so a
  // settle can refresh it once and every surface updates together.
  const { claimableCount, refresh: refreshSettlements } = useSettlements();
  const handleActivitySignIn = useCallback(async (): Promise<void> => {
    const token = await ensureSession();
    if (token) refreshOrders();
  }, [ensureSession, refreshOrders]);

  // Wallet-first swap log (localStorage + public status polling). Populates the
  // feed for wallet-only users; server history layers on top for Members. A swap
  // crossing into completed (e.g. while the flow modal is closed) toasts once.
  const handleSwapComplete = useCallback(
    (item: SwapActivityItem): void => {
      const from =
        getTokenInfoForChain(item.data.fromToken, item.data.fromChainId)?.symbol ??
        item.data.fromToken;
      const to =
        getTokenInfoForChain(item.data.toToken, item.data.toChainId)?.symbol ?? item.data.toToken;
      showToast(`${from} to ${to} swap complete`, "success");
    },
    [showToast],
  );
  const { swaps: localSwaps, refresh: refreshLocal } = useLocalActivity({
    onComplete: handleSwapComplete,
  });

  // Subscribe to the user's authorized agents' streams. Verified agent activity
  // is fed into the same local log (tagged "agent"), so it flows through
  // localSwaps above with no extra merge. Server never learns the link.
  const { agents } = useAgentRegistry();
  useAgentStream(agents);

  // Merge local swaps with server history, deduped by intent id. The server
  // record is authoritative, so it wins on conflict; anything only known
  // locally (a fresh wallet-first swap with no Member token) still shows.
  const activities = useMemo((): SwapActivityItem[] => {
    const serverSwaps: SwapActivityItem[] = orders.map((order) => ({
      id: order.id,
      type: "swap" as const,
      timestamp: order.timestamp,
      status:
        order.status === "completed"
          ? "completed"
          : order.status === "failed" || order.status === "expired"
            ? "failed"
            : "pending",
      intentStatus: order.status,
      data: {
        fromChainId: order.fromChainId,
        toChainId: order.toChainId,
        fromToken: order.fromToken,
        toToken: order.toToken,
        fromAmount: order.fromAmount,
        toAmount: order.toAmount,
        tier: order.tier,
        feeRate: order.feeRate,
        txHash: order.txHash,
        receivingTxHash: order.receivingTxHash,
        isCrossChain: order.isCrossChain,
        substatus: order.substatus,
        ...(order.settlementType === "public" && {
          settlementType: "public" as const,
          ...(order.recipientTag !== undefined && { recipientTag: order.recipientTag }),
        }),
        // Stealth would also put the claim action on server rows, a change of its own.
        ...(order.settlementType === "shielded" && {
          settlementType: "shielded" as const,
          destinationType: "aztec" as const,
        }),
      },
    }));
    const byId = new Map<string, SwapActivityItem>();

    for (const s of localSwaps) byId.set(s.id, s);
    for (const s of serverSwaps) {
      const local = byId.get(s.id);
      byId.set(s.id, mergeHistorySwap(s, local));
    }
    return [...byId.values()].sort((a, b) => b.timestamp - a.timestamp);
  }, [orders, localSwaps]);

  // Drive the refresh-button spinner from the action itself, not from the
  // server hook's incidental loading flag: that flag never turns on for the
  // common wallet-first / no-session path (doFetch short-circuits before it
  // sets loading), so the button looked inert. Floor the spin at a perceptible
  // duration so a fast or no-op refresh still reads as "refreshing".
  const [isRefreshing, setIsRefreshing] = useState(false);
  const refreshActivity = useCallback((): void => {
    setIsRefreshing(true);
    const settled = Promise.allSettled([refreshOrders(), refreshLocal()]);
    const floor = new Promise((resolve) => setTimeout(resolve, MIN_REFRESH_SPIN_MS));
    void Promise.all([settled, floor]).then(() => setIsRefreshing(false));
  }, [refreshOrders, refreshLocal]);

  // In-frame tabs. Claims exists only where its content can render (stealth
  // receive live + a connected wallet); when it disappears while selected (the
  // wallet disconnects), the selection falls back to Swap. Every panel stays
  // mounted and is only hidden, so leaving Swap mid-quote keeps the quote, the
  // flow modal and every in-progress field exactly as they were.
  const tabsBaseId = useId();
  const claimsAvailable = tabsShown && STEALTH_CLAIM_LIVE && isConnected;
  const [selectedTab, setSelectedTab] = useState<WidgetTabId>("swap");
  if (selectedTab === "claims" && !claimsAvailable) setSelectedTab("swap");
  // Opened from a tabless frame's claim link (`#claims`): land on Claims as
  // soon as it exists, which is after the wallet reconnects. Any tab the user
  // picks first wins.
  const [claimsWanted, setClaimsWanted] = useState(
    () => tabsShown && window.location.hash === CLAIMS_HASH,
  );
  if (claimsWanted && claimsAvailable) {
    setClaimsWanted(false);
    setSelectedTab("claims");
  }
  const selectTab = useCallback((tab: WidgetTabId): void => {
    setClaimsWanted(false);
    setSelectedTab(tab);
  }, []);
  const tabs: WidgetTab[] = [
    { id: "swap", label: "Swap" },
    { id: "activity", label: "Activity" },
    ...(claimsAvailable
      ? [
          {
            id: "claims" as const,
            label: "Claims",
            count: claimableCount,
            countLabel: "ready to claim",
          },
        ]
      : []),
  ];
  const panelProps = (tab: WidgetTabId) => {
    // Without the tab row the swap card is the whole widget, not a tab panel.
    if (!tabsShown) return { className: "widget-panel" } as const;
    const ids = widgetTabIds(tabsBaseId, tab);
    return {
      role: "tabpanel",
      id: ids.panel,
      "aria-labelledby": ids.tab,
      hidden: selectedTab !== tab,
      className: "widget-panel",
    } as const;
  };

  // Retry: lift a prefill for SwapPanel. A monotonic nonce makes each click
  // distinct so re-clicking the same row re-applies (SwapPanel keys off it).
  const [retryPrefill, setRetryPrefill] = useState<SwapPrefill | null>(null);
  const retryNonce = useRef(0);

  // A stealth swap settles to a one-time private address the user must claim. When
  // one settles in the full widget, auto-scan so the payment appears in the receive
  // panel, and switch to the Claims tab -- otherwise the claim step is invisible
  // (see #352). The receipt's "Claim your payment" lands here too, in that layout.
  //
  // With tabs, `scan()` is not gated on `keysReady`. It used to be, and that
  // was read from a SEPARATE useStealth instance than the one the swap panel
  // derived keys into, so it was false on the very swap that just settled and
  // the auto-scan never ran (fixed at the source: useStealth is now a single
  // shared provider). Calling it regardless is also more honest than the old
  // silent skip: when keys or a wallet session really are missing, the scanner
  // sets a visible reason and the panel renders the matching affordance.
  //
  // Without tabs (`layout=swap`) there is no Claims panel to land on, so a
  // settlement refreshes the count and does not scan; the receipt's Claim
  // payment goes to `openClaims` instead and never reaches this handler. The
  // count needs a wallet session, which the wallet-first default lacks, and the
  // receipt's Claim payment goes once the flow modal closes, so the settlement
  // is remembered and keeps the claims row up as the way to claim it (the #352
  // invisible-claim failure, in a tabless frame).
  const [stealthSettledHere, setStealthSettledHere] = useState(false);
  const handleStealthSettled = useCallback((): void => {
    // A stealth settlement is exactly when a new claimable row appears
    // server-side, and the count is otherwise only fetched once at page load.
    refreshSettlements();
    if (!tabsShown) {
      setStealthSettledHere(true);
      return;
    }
    void stealthClaim.scan();
    selectTab("claims");
  }, [tabsShown, stealthClaim, refreshSettlements, selectTab]);

  // The claims nudge (and the history row's claim action) promise "a payment is
  // ready", so the landing must show that payment or the step that unlocks it.
  // With keys absent, StealthClaims is unmounted (gated on isInitialized below)
  // and a scan can only fail into a panel that is not there -- skip it and let
  // the Claims tab show PrivacyPanel's initialize affordance instead.
  const handleClaimNudge = useCallback((): void => {
    if (stealthClaim.isInitialized) {
      void stealthClaim.scan();
    }
    refreshSettlements();
    selectTab("claims");
  }, [stealthClaim, refreshSettlements, selectTab]);

  // A tabless frame claims on the full widget, in a tab of its own.
  const openClaims = useCallback((): void => {
    window.open(claimsPath(look.theme), "_blank", "noopener,noreferrer");
  }, [look.theme]);

  // Scanning reads the Member-gated announcements index, so a wallet-first user
  // (the documented default: no passkey, no sign-in) cannot scan at all. Offer
  // the sign-in from the panel rather than only reporting it as an error.
  const stealthNeedsSignIn = isConnected && !!address && !hasWalletSession(address);
  const stealthSignInRequest = useRef<object | null>(null);
  const [pendingStealthScan, setPendingStealthScan] = useState<{
    request: object;
    token: string;
    generation: number;
  } | null>(null);
  useEffect(() => {
    const unsubscribe = watchAccount(config, {
      onChange(account, previous) {
        if (
          account.status !== "connected" ||
          account.address?.toLowerCase() !== previous.address?.toLowerCase() ||
          account.chainId !== previous.chainId ||
          account.connector?.uid !== previous.connector?.uid
        ) {
          stealthSignInRequest.current = null;
        }
      },
    });
    return () => {
      stealthSignInRequest.current = null;
      unsubscribe();
    };
  }, [config]);
  const handleStealthSignIn = useCallback((): void => {
    const request = {};
    stealthSignInRequest.current = request;
    void ensureSession().then((token) => {
      if (token && stealthSignInRequest.current === request) {
        setPendingStealthScan({ request, token, generation: getWalletSessionGeneration() });
      }
    });
  }, [ensureSession]);
  // Signing in revokes the pre-auth scanner. Consume the explicit request only
  // after rendering its replacement, never through the callback that signed in.
  useEffect(() => {
    if (!pendingStealthScan) return;
    setPendingStealthScan(null);
    if (
      stealthSignInRequest.current !== pendingStealthScan.request ||
      sessionState !== "active" ||
      getWalletToken() !== pendingStealthScan.token ||
      getWalletSessionGeneration() !== pendingStealthScan.generation
    ) {
      return;
    }
    stealthSignInRequest.current = null;
    void stealthClaim.scan();
    refreshSettlements();
  }, [pendingStealthScan, sessionState, stealthClaim.scan, refreshSettlements]);

  const handleRetrySwap = useCallback(
    (item: SwapActivityItem): void => {
      retryNonce.current += 1;
      setRetryPrefill({
        nonce: retryNonce.current,
        fromChainId: item.data.fromChainId,
        toChainId: item.data.toChainId,
        fromToken: item.data.fromToken,
        toToken: item.data.toToken,
        fromAmount: item.data.fromAmount,
        settlement: item.data.settlementType,
        recipientTag: item.data.recipientTag,
        refundAddress: item.data.deposit?.attested.refund_address ?? undefined,
      });
      selectTab("swap");
    },
    [selectTab],
  );

  // Report: assemble a failure reference from the history row and fire the same
  // best-effort POST /api/report the live modal uses. It never throws (the
  // client swallows + logs transport errors), so confirm optimistically.
  const handleReportSwap = useCallback(
    (item: SwapActivityItem): void => {
      const ref = buildHistoryFailureRef(item, address, APP_VERSION);
      void reportSwapFailure(ref);
      showToast("Thanks. Report received.", "success");
    },
    [address, showToast],
  );

  return (
    <WidgetTabsContext value={tabsShown}>
      <ClaimInXochiAppContext value={claimInXochiApp}>
        <main
          className={[
            "launch-screen",
            tabsShown ? "launch-screen--full" : null,
            look.height === null ? null : "launch-screen--fixed",
          ]
            .filter(Boolean)
            .join(" ")}
          style={look.height === null ? undefined : { height: `${look.height}px` }}
        >
          {/* Top row at the card's width: the tabs, plus the connected wallet's
          account chip. The card's own CTA is the one connect action, so the
          chip renders nothing while disconnected (and the row collapses). */}
          <div className="widget-bar">
            {tabsShown && (
              <WidgetTabs
                baseId={tabsBaseId}
                tabs={tabs}
                active={selectedTab}
                onSelect={selectTab}
              />
            )}
            {!hostOwnsWalletUi && <AccountChip />}
          </div>

          <div {...panelProps("swap")}>
            <SwapPanel
              prefill={retryPrefill}
              onStealthSettled={handleStealthSettled}
              onGoToClaims={tabsShown || claimInXochiApp ? undefined : openClaims}
              howItWorks={look.howItWorks}
              onConnectRequest={hostOwnsWalletUi ? requestHostConnect : undefined}
            />

            <MobileSigningBanner />

            {/* Compact claims row, rendered only while something is actually waiting
            (the fable pass-1 ruling: claimable settlements surface after the
            card, not as a standing panel). Clicking scans and switches to the
            Claims tab, or without tabs opens the full widget on Claims; there
            it also stays after a stealth swap settles in this frame, even
            before a session can count the payment. */}
            {STEALTH_CLAIM_LIVE &&
              (claimableCount > 0 || (!tabsShown && stealthSettledHere)) &&
              (claimInXochiApp ? (
                // The host's wallet: no claim here or in a tab of the widget's own.
                <p className="claims-nudge" role="note">
                  {claimableCount > 0
                    ? `${claimableCount} private ${claimableCount === 1 ? "payment is" : "payments are"} ready. `
                    : "Your private payment landed. "}
                  {CLAIM_IN_XOCHI_APP}
                </p>
              ) : (
                <button
                  type="button"
                  className="claims-nudge"
                  onClick={tabsShown ? handleClaimNudge : openClaims}
                >
                  {claimableCount > 0 ? (
                    <>
                      <span className="claims-nudge__count">{claimableCount}</span>
                      {claimableCount === 1 ? "payment is" : "payments are"} ready to claim
                    </>
                  ) : (
                    "Claim your private payment"
                  )}
                  <span className="claims-nudge__arrow" aria-hidden="true">
                    {"->"}
                  </span>
                </button>
              ))}
          </div>

          {tabsShown && (
            <div {...panelProps("activity")}>
              {/* Holdings breakdown. Disconnected visitors already see balance context
              inline in the pay field ("--"), so the strip's old connect prompt
              would be a second wallet ask; render nothing instead. */}
              {isConnected && <AssetsStrip />}

              <section className="launch-txlog" aria-label="Transaction log">
                <ActivityFeed
                  activities={activities}
                  isLoading={ordersLoading || isRefreshing}
                  error={ordersError}
                  hasMore={hasMoreOrders}
                  isConnected={isConnected}
                  connectedWallet={address}
                  sessionWallet={sessionWallet}
                  needsSignIn={historyNeedsSignIn}
                  isSigningIn={sessionState === "signing"}
                  onSignIn={handleActivitySignIn}
                  onRefresh={refreshActivity}
                  onLoadMore={loadMoreOrders}
                  onReportSwap={handleReportSwap}
                  onRetrySwap={handleRetrySwap}
                  onClaimNudge={STEALTH_CLAIM_LIVE ? handleClaimNudge : undefined}
                />
              </section>
            </div>
          )}

          {/* Standalone privacy/trust UI renders only when it is relevant: a
          connected wallet can initialize keys, register, scan, and claim; an
          anonymous visitor can do none of that, so the Claims tab does not
          exist for them (trade-widget-mvp.md: "appears only when relevant or
          requested"). The in-form surfaces (toggle captions, contextual stealth
          notices) carry the education. */}
          {claimsAvailable && (
            <div {...panelProps("claims")}>
              <section className="launch-stealth" aria-label="Private receiving">
                <PrivacyPanel
                  trustScore={trustScore}
                  disclosuresLive={features.verificationBetaLive}
                  shieldedAccountsLive={SHIELDED_ACCOUNTS_LIVE}
                  connectedProviders={verifyState?.connectedProviders ?? []}
                  isConnected={isConnected}
                  stealthInitialized={stealthClaim.isInitialized}
                  stealthRegistered={stealthClaim.isRegistered}
                  onInitializeStealth={stealthClaim.initializeKeys}
                  onRegisterStealth={stealthClaim.registerMetaAddress}
                  stealthLoading={stealthClaim.isLoading}
                />

                {stealthClaim.isInitialized && (
                  <StealthClaims
                    payments={stealthClaim.payments}
                    isScanning={stealthClaim.isScanning}
                    isClaiming={stealthClaim.isClaiming}
                    isConfirming={stealthClaim.isConfirming}
                    isStealthReady={stealthClaim.keysReady}
                    onResign={stealthClaim.initializeKeys}
                    isResigning={stealthClaim.isLoading}
                    walletAddress={address}
                    error={stealthClaim.error}
                    lastScannedBlock={stealthClaim.lastScannedBlock}
                    hasScanned={stealthClaim.hasScanned}
                    needsSignIn={stealthNeedsSignIn}
                    isSigningIn={sessionState === "signing"}
                    onSignIn={handleStealthSignIn}
                    claimableCount={claimableCount}
                    onScan={stealthClaim.scan}
                    onClaim={stealthClaim.claim}
                    onClaimAll={stealthClaim.claimAll}
                  />
                )}
              </section>
            </div>
          )}
        </main>
      </ClaimInXochiAppContext>
    </WidgetTabsContext>
  );
}
