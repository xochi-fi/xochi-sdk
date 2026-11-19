import { useEffect, useRef, useState } from "react";
import { getAccount, sendTransaction, waitForTransactionReceipt } from "@wagmi/core";
import { useAccount, useConfig } from "wagmi";
import type { Address } from "viem";
import {
  buildRegisterStealthMetaAddressTx,
  readStealthRegistration,
} from "../../lib/recipient/index.js";
import { chainName } from "./addressSend.js";
import { useRecipientDeps } from "./useSendRecipient.js";
import { buildQrSvg } from "../../lib/qr.js";
import { useStealth } from "../../hooks/useStealth.js";

function ReceiveValue({ label, value }: { label: string; value: string }) {
  const { path, size } = buildQrSvg(value);
  const [feedback, setFeedback] = useState("");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setFeedback("Copied");
    } catch {
      setFeedback("Select the address to copy it");
    }
  };
  return (
    <div className="send-receive__value">
      <strong>{label}</strong>
      <code className="send-review__mono">{value}</code>
      <svg
        viewBox={`0 0 ${size} ${size}`}
        width="110"
        height="110"
        role="img"
        aria-label={`${label} QR code`}
      >
        <rect width={size} height={size} fill="white" />
        <path d={path} fill="black" shapeRendering="crispEdges" />
      </svg>
      <button type="button" className="send-secondary" onClick={() => void copy()}>
        Copy
      </button>
      <span role="status">{feedback}</span>
    </div>
  );
}

export function Receive({ onConnect }: { onConnect?: () => void }) {
  const { address, chainId, status: walletStatus } = useAccount();
  const config = useConfig();
  const stealth = useStealth();
  const deps = useRecipientDeps();
  const pending = useRef(false);
  const [revision, refresh] = useState(0);
  const [checked, setChecked] = useState<{
    address: Address;
    status: Awaited<ReturnType<typeof readStealthRegistration>>;
  }>();
  const [review, setReview] = useState<{ address: Address; chainId: number; meta: string }>();
  const [submission, setSubmission] = useState<"idle" | "pending" | "failed">("idle");
  const meta = stealth.encodedMetaAddress;
  const status = checked?.address === address ? checked?.status : undefined;

  useEffect(() => {
    if (!address || !deps) return;
    const controller = new AbortController();
    const { signal } = controller;
    void readStealthRegistration(address, deps, signal).then((value) => {
      if (!signal.aborted) setChecked({ address, status: value });
    });
    return () => controller.abort();
  }, [address, deps, revision]);

  let tx: ReturnType<typeof buildRegisterStealthMetaAddressTx> | undefined;
  if (chainId && meta) {
    try {
      tx = buildRegisterStealthMetaAddressTx(meta, chainId);
    } catch {
      // No deployment on the connected chain.
    }
  }

  const approve = async () => {
    if (!review || !tx || pending.current) return;
    const account = getAccount(config);
    if (
      account.status !== "connected" ||
      review.address !== account.address ||
      review.chainId !== account.chainId ||
      review.meta !== meta
    )
      return;
    pending.current = true;
    setSubmission("pending");
    try {
      const chainId = review.chainId;
      const hash = await sendTransaction(config, { ...tx, chainId, account: review.address });
      const receipt = await waitForTransactionReceipt(config, { hash, chainId });
      if (receipt.status !== "success") throw new Error("Registration reverted");
      setChecked({ address: review.address, status: "published" });
      setReview(undefined);
      setSubmission("idle");
    } catch {
      setSubmission("failed");
      refresh((previous) => previous + 1);
    } finally {
      pending.current = false;
    }
  };

  if (!address)
    return (
      <>
        <p className="send-note">Connect your wallet so people can send to you with Stealth.</p>
        <button type="button" className="submit-btn send-cta" onClick={onConnect}>
          Connect wallet
        </button>
      </>
    );
  return (
    <section className="send-review" aria-label="Receive">
      <ReceiveValue key={address} label="Wallet address" value={address} />
      {meta ? (
        <>
          <p className="send-note">Share this so people can send to you with Stealth.</p>
          <ReceiveValue key={meta} label="Stealth meta-address" value={meta} />
          {status !== "published" &&
            chainId &&
            tx &&
            (review &&
            review.address === address &&
            review.chainId === chainId &&
            review.meta === meta ? (
              <>
                <p className="send-note">
                  Your Stealth receiving details become public and linked to this wallet.
                </p>
                <p className="send-note">On {chainName(chainId)}</p>
                {submission === "failed" && <p role="alert">Registration could not be confirmed</p>}
                <div className="send-review__actions">
                  <button
                    type="button"
                    className="send-secondary"
                    disabled={submission === "pending"}
                    onClick={() => setReview(undefined)}
                  >
                    Back
                  </button>
                  <button
                    type="button"
                    className="submit-btn send-cta"
                    disabled={walletStatus !== "connected" || submission === "pending"}
                    onClick={() => void approve()}
                  >
                    {submission === "pending"
                      ? "Waiting for wallet or network…"
                      : "Confirm in wallet"}
                  </button>
                </div>
              </>
            ) : (
              <>
                <p className="send-note">
                  Publish your Stealth receiving details so people can find them from your wallet
                  address.
                </p>
                <button
                  type="button"
                  className="send-secondary"
                  onClick={() => {
                    setSubmission("idle");
                    setReview({ address, chainId, meta });
                  }}
                >
                  Publish Stealth details
                </button>
              </>
            ))}
        </>
      ) : (
        <>
          <p className="send-note">Sign a message in your wallet to set up Stealth.</p>
          <button
            type="button"
            className="send-secondary"
            disabled={walletStatus !== "connected" || stealth.isLoading}
            onClick={() => void stealth.initializeKeys()}
          >
            Set up Stealth
          </button>
          {stealth.error && <p role="alert">Stealth setup could not finish</p>}
        </>
      )}
      <p className="send-note" role="status">
        {status === "published"
          ? "Stealth details published"
          : status === "not_published"
            ? "Stealth details unpublished"
            : status === "unknown" || !deps
              ? "Registration status unavailable"
              : "Checking registration…"}
      </p>
    </section>
  );
}
