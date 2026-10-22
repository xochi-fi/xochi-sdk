# 0002. Dogfood the public widget

**Date**: 2026-10-12
**Status**: Proposed

## Context

Three surfaces run the same swap today, and only one of them is the product:

- **`xochi-widget`** serves `widget.xochi.fi` (and `widget-stg.xochi.fi`): the
  swap frame at `/embed` and the integrator configurator at `/`. Its preview is
  a raw `<iframe>` and its snippet is a raw `<iframe>`. It keeps its own trade
  machine (`packages/machine`) and its own embed-parameter rules
  (`src/pages/trade/embedParams.ts`), and imports `@xochi/shared` from the
  private xochi repo. xochi-widget#53 moves it onto `@xochi/client` and
  `@xochi/widget-lib`; it waits on the first npm publish.
- **`xochi`** still ships the original swap at `xochi.fi/trade`: about 250 files
  under `src/` that share a path with xochi-widget (167 byte-identical, 83
  already diverged), plus wagmi, RainbowKit and WalletConnect.
- **`@xochi/widget-lib`** (this repo) defines the public embed contract:
  `params.ts` (six syntax-only defaults) and the host side of the frame protocol
  (handshake, EIP-1193 relay, resize, `trade:*` events). No surface we run uses
  it yet.

Meanwhile the configurator work on staging (xochi-widget#56 -> #62 -> #67 ->
#72 -> #73) found the rest of the embed contract by building it against
`widget-stg`: `theme`, `layout`, `howItWorks`, fixed height, locks, per-side
chain and token allow-lists, `ref` and `promo`. It wrote all of it into the
widget's private `embedParams.ts`, so integrators cannot use any of it and
#53 would have to port it.

## Decision

1. **Our own surfaces integrate through the public packages, the same way a
   third party does.** If xochi.fi or the configurator needs something,
   widget-lib or client grows it, or nobody gets it.
2. **Syntax in widget-lib, semantics in the frame.** Every frame parameter's
   name, syntax and encoding lives in `@xochi/widget-lib` `params.ts`
   (`encodeEmbedParams` / `parseEmbedParams`). What a value means against the
   live capability matrix (fallbacks, allow-list intersection, the reasons the
   configurator shows) stays in the frame, because it needs the matrix and the
   token registry at load.
3. **The configurator is widget-lib's first host.** Its preview mounts through
   `createXochiWidget` and its snippet emits `createXochiWidget({ ... })` (with
   the raw iframe as a fallback). Every option therefore round-trips through
   the public encoder, which makes the configurator a contract test for
   widget-lib. What it hands an integrator is third-party output: the snippet,
   its raw-iframe fallback and the shareable URL (Decision 8) never carry
   `autoConnect: true` (widget-lib's default `false` is the third-party
   default; only xochi.fi sets it, Decision 7) and never carry a lock or
   allow-list (Decision 6), which the configurator applies to its own preview
   only. The configurator's round-trip test asserts both on every emitted
   snippet and URL.
4. **Staging defines the contract; `next` carries it.** A new parameter lands
   in widget-lib first and ships as a prerelease (`widget-lib-v0.2.0-next.N`,
   which `release.yml` already publishes under the `next` dist-tag).
   widget-stg and its branch previews build against `next`; widget.xochi.fi
   pins a stable version. The configurator offers no option that the pinned
   widget-lib cannot encode.
5. **Height is a host option.** `createXochiWidget({ height: number | "auto" })`.
   `auto` uses the existing resize message; a number sets the iframe height and
   passes the frame the fixed-height mode it needs to scroll inside itself.
6. **Locks and allow-lists stay frame-private until the server enforces them
   per publishable key.** xochi#579 closed as completed on 2026-10-08
   (xochi#592): publishable keys (`pk_live_` / `pk_test_`) now exist with an
   origin allowlist and a stored policy, behind `API_KEYS_ENABLED` (off). That
   policy has no lock or chain/token allow-list field, and quote and execute
   check none, so the condition this decision waits on still does not hold:
   it needs a policy field the Worker enforces on quote and execute, which no
   longer has #579 as its tracker. The configurator can set locks and
   allow-lists on its own preview; the widget-lib types do not expose them,
   because a host must not mistake a browser-side convenience for a checkout
   guarantee.
7. **xochi.fi hosts the widget.** `xochi.fi/trade` becomes a `createXochiWidget`
   host that lends the frame its connected wallet (`autoConnect` when already
   connected). Until the embed prerequisites below hold, `/trade` redirects new
   swaps to `widget.xochi.fi`, and xochi deletes its swap code and the wallet
   stack only once the drain (Order step 6) has ended.
8. **One deployable for the widget.** `xochi-widget` keeps serving both the
   live frame (`/embed`) and the configurator (`/`) on `widget.xochi.fi` and
   `widget-stg.xochi.fi`, as `widget.cow.fi` does. The configurator is the way
   to demo a configuration on either environment: its shareable URL reproduces
   a configuration exactly, except the frame-private locks and allow-lists it
   never serializes (Decision 6). The repo is not renamed to "configurator":
   its main artifact is the frame.

## Order

1. Publish the first versions from main: `@xochi/spec` at the version its
   `package.json` carries when the tag is cut (`release.yml` refuses a tag
   that differs from it), which is 0.8.1 today and 0.9.0 once xochi-sdk#43
   merges; signer 0.5.1, client 0.1.1 with the neutral referral line,
   widget-lib 0.1.1. Riddler advertises the published spec version in
   lockstep, or the nightly spec-version probe reports drift.
2. Merge xochi-widget#53 and xochi#611 against the published versions.
3. widget-lib 0.2 (prerelease on `next`): the configurator parameters except
   locks and allow-lists (Decision 6), and the `height` option. Rebase the
   configurator stack onto #53 so each PR keeps only frame semantics and
   configurator UI.
4. Configurator preview and snippet on `createXochiWidget`; widget-stg on
   `next`.
5. Give the stealth key namespace a public home before anything retires
   `@xochi/shared`'s public half: move `STEALTH_DERIVE_MESSAGE` and
   `encodeMetaAddress` into `@xochi/signer`, with a test that pins both byte
   for byte against the values xochi publishes in `@xochi-fi/shared`
   (`packages/shared/src/stealth.ts`, a value this repo cannot edit), publish
   it, and move xochi-widget's imports to it. Retyping that string, or
   changing one byte of it, derives different keys, so stealth funds already
   received match no announcement. Step 6 does not start while anything
   imports either from `@xochi/shared`.
6. `xochi.fi/trade` redirects new swaps to `widget.xochi.fi`, behind a drain:
   - Wallet sessions (`sessionStorage`) and stealth meta-addresses
     (`localStorage`) are per origin and do not follow the redirect. xochi.fi
     keeps serving intent status and stealth claims for every intent opened
     there, and tells the user before redirecting.
   - On `widget.xochi.fi` the frame re-derives stealth keys from the same
     derive message (step 5), so a wallet whose signature over it is
     deterministic recovers its state. A wallet whose signature is not (some
     smart accounts) derives different keys there, so its keys exist only on
     xochi.fi, and xochi.fi's claim path stays until the drain ends.
   - The drain ends when no intent opened on xochi.fi is non-terminal and a
     claim notice period announced with the redirect has passed. Only then
     does xochi delete its swap code, the trade-only dependencies and the
     public half of `@xochi/shared` (`publish-shared.yml` retires when
     nothing outside xochi imports it).
7. Embed on xochi.fi once its prerequisites hold.

## Prerequisites for embedding on xochi.fi

- `frame-ancestors` on widget.xochi.fi admits `https://xochi.fi` only, and
  on widget-stg.xochi.fi `https://staging.xochi.fi` only. Staging builds on
  `next` prereleases and branch previews (Decision 4), so it never frames the
  production widget and its real wallet bridge. First-party only; third-party
  embedding stays a separate decision (xochi#573).
- The framed-context fixes from xochi-widget#41 (draft PR #60): derive stealth
  keys only from a signature that recovers to the connected address (T1), drop
  keys and meta-address on an in-frame account switch (T4), a wallet prompt
  before any claim (T7), and a host bridge that refuses the derive message and
  the SIWE challenge (T10).
- The frame implements the widget-lib protocol (xochi-widget#53).

## Consequences

- One definition of every embed parameter, used by integrators, the
  configurator and xochi.fi alike. A parameter cannot exist in the configurator
  without existing in widget-lib.
- xochi stops shipping a swap: about 2 MB of duplicated source and the wallet
  dependencies leave the repo, and with them the drift between two copies.
- Every widget-lib change is now on the critical path of the widget and of
  xochi.fi. The `next` channel and the configurator round-trip keep that path
  short, but a broken prerelease breaks staging.
- Until the embed prerequisites hold, xochi.fi users leave xochi.fi to trade.

## Alternatives considered

- **Land the configurator stack first, port it in #53.** Rejected: the
  parameter rules would be written twice, once privately.
- **Publish locks and allow-lists now, documented as client-side.** Rejected
  for now (Decision 6); revisit when the Worker enforces them per publishable
  key (xochi#579's keys carry no such policy field).
- **Move the configurator to xochi.fi.** Rejected: the configurator needs the
  frame's semantic checks, which live with the frame; moving it would put a
  second copy of them in xochi.
- **Keep `xochi.fi/trade` as a separate app.** Rejected: it is the duplication
  this ADR removes.
