import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TRON_CHAIN_ID } from "@xochi/client";
import { DepositInstructions } from "./DepositInstructions.js";

const DEPOSIT_ADDR = "TByzQxR5N4jJ9wD8m6Yb3s2Kf1H7cV0aQ";
const REFUND_ADDR = "TMVQGm1qAQYVdetCeGRRkTWYYrLXuHK2HC";

type Overrides = Partial<Parameters<typeof DepositInstructions>[0]>;

// Render the real deposit view (Tron origin -> Base dest) to static markup.
const html = (overrides: Overrides = {}): string =>
  renderToStaticMarkup(
    createElement(DepositInstructions, {
      depositAddress: DEPOSIT_ADDR,
      fromAmount: "1000000",
      fromSymbol: "USDC",
      fromDecimals: 6,
      fromChainId: TRON_CHAIN_ID,
      toSymbol: "USDC",
      toChainId: 8453,
      ...overrides,
    }),
  );

/** A deadline `secs` from now, in unix seconds, as the component reads it. */
const deadlineIn = (secs: number): number => Math.floor(Date.now() / 1000) + secs;

describe("DepositInstructions QR", () => {
  it("renders a labelled QR svg with drawn modules", () => {
    const out = html();
    expect(out).toContain('role="img"');
    expect(out).toContain("QR code of the USDC deposit address");
    expect(out).toContain("<path"); // dark modules are drawn
  });

  it("keeps the address copyable (the QR is additive, not a replacement)", () => {
    const out = html();
    expect(out).toContain(DEPOSIT_ADDR);
    expect(out).toContain("Copy");
  });
});

// The window is enforced once, at quote-ingest, before this view exists
// (verifyDepositAttestation refuses a route with under DEPOSIT_MIN_WINDOW_SECONDS
// left). It then runs out while the user is looking at the screen. A deposit that
// lands late is refunded rather than filled, so the address has to stop being an
// invitation rather than sit under a warning as the weakest thing on the page.
describe("DepositInstructions deposit window", () => {
  it("shows the address and the countdown while the window is open", () => {
    const out = html({ depositDeadline: deadlineIn(600) });
    expect(out).toContain(DEPOSIT_ADDR);
    expect(out).toContain("Send within");
    expect(out).toContain("Waiting for the deposit");
  });

  it("withdraws the address, the QR and the Copy button once the window closes", () => {
    const out = html({ depositDeadline: deadlineIn(-1) });
    expect(out).not.toContain(DEPOSIT_ADDR);
    expect(out).not.toContain("QR code of the USDC deposit address");
    expect(out).not.toContain(">Copy<");
  });

  it("tells the user not to send, and that an in-flight deposit is safe", () => {
    const out = html({ depositDeadline: deadlineIn(-1) });
    expect(out).toContain("Do not send anything to that address");
    expect(out).toContain("was already sent");
    // Not "Waiting for the deposit": a deposit sent now would not be filled.
    expect(out).not.toContain("Waiting for the deposit");
  });

  it("names the refund destination in the closed state when one was given", () => {
    const out = html({ depositDeadline: deadlineIn(-1), refundAddress: REFUND_ADDR });
    expect(out).toContain("TMVQGm...K2HC");
  });

  // An absent deadline is the shape of an unattested/legacy response, not a
  // window that never closes, so the view is left exactly as it was.
  it("leaves the view open when no deadline is attested", () => {
    const out = html();
    expect(out).toContain(DEPOSIT_ADDR);
    expect(out).not.toContain("Do not send anything to that address");
    expect(out).not.toContain("Send within");
  });
});

// The refund address is signed into the v3 attestation, so it is binding by the
// time this renders. Echoed because this is the last screen before the user
// sends: a typo that passes VM validation is a real address on the right chain,
// and without an echo it is only discoverable after a fill fails.
describe("DepositInstructions refund echo", () => {
  it("echoes the refund address the quote was requested with", () => {
    const out = html({ refundAddress: REFUND_ADDR, depositDeadline: deadlineIn(600) });
    expect(out).toContain("If it cannot go through, we send it back to");
    expect(out).toContain("TMVQGm...K2HC");
  });

  // Used to say nothing at all when no address was named, on the reasoning that
  // refund-to-sender needs no echo because the user knows what they paid from.
  // That is the case that most needs saying: a user withdrawing from an exchange
  // sends from the exchange's hot wallet, so "back where it came from" is an
  // address they do not control and the refund may never reach them.
  it("names refund-to-sender and its exchange caveat when the user named none", () => {
    const out = html({ depositDeadline: deadlineIn(600) });
    expect(out).toContain("we send it back to the sending address");
    expect(out).toContain("If that was an exchange account, the refund may be lost");
  });

  it("drops the exchange caveat once an address is named", () => {
    const out = html({ refundAddress: REFUND_ADDR, depositDeadline: deadlineIn(600) });
    expect(out).not.toContain("exchange account");
  });

  // The warning has to land BEFORE the money moves. It used to appear only on
  // the closed-window view, by which point the deposit is already gone.
  it("warns on the open view, not only after the window has closed", () => {
    const open = html({ depositDeadline: deadlineIn(600) });
    const closed = html({ depositDeadline: deadlineIn(-5) });
    expect(open).toContain("exchange account");
    expect(closed).toContain("exchange account");
  });
});

// "Nothing is lost" was unconditional, and it was false in exactly the case it
// was most likely to be read: a CEX withdrawal refunded to the exchange's hot
// wallet. And "Close this and start again" asked for something the panel
// refuses, since closing at the deposit phase leaves the intent in
// awaiting_deposit, which suppresses re-quoting.
describe("DepositInstructions closed window (promises the app can keep)", () => {
  it("no longer claims nothing is lost", () => {
    expect(html({ depositDeadline: deadlineIn(-5) })).not.toContain("Nothing is lost");
  });

  it("no longer tells the user to close and start again", () => {
    expect(html({ depositDeadline: deadlineIn(-5) })).not.toContain("Close this and start again");
  });

  it("offers a real action when the panel can honour one", () => {
    const out = html({ depositDeadline: deadlineIn(-5), onStartOver: () => {} });
    expect(out).toContain("Get a fresh address");
  });

  // Rendered dead would be the same bug in a new shape.
  it("omits the action entirely when no handler is wired", () => {
    expect(html({ depositDeadline: deadlineIn(-5) })).not.toContain("Get a fresh address");
  });
});

// A spinner reading "checking" is a claim about the CLIENT, not the solver. The
// status poll used to stop at 10 minutes inside a 30-minute deposit window, so
// this indicator went on asserting a check that had already ended: a stopped
// poll and a poll that had found nothing rendered identically. Both states are
// now nameable, and these pin them apart.
describe("DepositInstructions check indicator (absent check != negative check)", () => {
  it("claims an active check only while the poll is running", () => {
    const out = html({ depositDeadline: deadlineIn(600), checkActive: true });
    expect(out).toContain("Waiting for the deposit...");
    expect(out).toContain("spinner");
    expect(out).not.toContain("stopped checking");
  });

  it("stops claiming a check once the poll has given up", () => {
    const out = html({ depositDeadline: deadlineIn(600), checkActive: false });
    expect(out).toContain("Deposit check stopped");
    expect(out).not.toContain("Waiting for the deposit...");
    expect(out).not.toContain("spinner");
  });

  it("does the same on the closed-window view, which is where it mattered", () => {
    const live = html({ depositDeadline: deadlineIn(-5), checkActive: true });
    expect(live).toContain("Checking for a deposit already on its way...");

    const dead = html({ depositDeadline: deadlineIn(-5), checkActive: false });
    expect(dead).not.toContain("Checking for a deposit already on its way...");
    expect(dead).toContain("Deposit check stopped");
  });

  // Omitting the prop must not mute the indicator: a new call site that forgets
  // it should over-report a live check, never silently claim none.
  it("defaults to reporting an active check", () => {
    expect(html({ depositDeadline: deadlineIn(600) })).toContain("Waiting for the deposit...");
  });
});
