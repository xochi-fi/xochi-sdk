# 0003. The widget frame lives in xochi-sdk

**Date**: 2026-11-02
**Status**: Accepted
**Amends**: [0002](0002-dogfood-the-widget.md) Decisions 2 and 8

## Context

ADR 0002 put every embed parameter's syntax in `@xochi/widget-lib` and left
the frame, the swap app served at `widget.xochi.fi/embed`, in the private
`xochi-widget` repo. That repo now holds three apps behind one router:

- `/embed`, the frame: swap, stealth, wallet stack, activity, claims. Nearly
  all of its 167 non-test source files.
- `/`, the integrator configurator.
- `/affiliate`, the referral earnings dashboard.

Every widget improvement therefore lands in a private repo. Integrators cannot
read the code that builds and checks what their users sign, which is the
reason ADR 0001 put `@xochi/client` in this public repo rather than in xochi.
A contract change needs a widget-lib release here and a frame change there,
filed and reviewed twice.

`xochi-widget` is meant to be a minimal implementation that serves the
`widget.xochi.fi` website, not the home of the widget.

## Decision

1. **`@xochi/widget`** (`packages/widget`): a new public package holding the
   whole frame app. It exposes one mount entry for the frame, not individual
   components, and releases on its own `widget-v*` tags.
2. **`xochi-widget` is the website and the deploy shell.** It keeps the
   configurator (`/`), the affiliate dashboard (`/affiliate`), the security
   headers and `frame-ancestors`, and the vendored widget-lib browser ESM. Its
   `/embed` only mounts `@xochi/widget`, exact-pinned. It holds no frame code.
3. **Widget improvements are filed and built here.** Issues for the frame go
   to this repo. A finding that names an unfixed weakness stays in the private
   `xochi-widget` tracker until its fix ships, per `SECURITY.md`.
4. **Syntax in widget-lib, semantics in `@xochi/widget`.** ADR 0002 Decision 2
   stands as a split between packages instead of repos. What a parameter means
   against the live capability matrix lives in `@xochi/widget`; the
   configurator imports it from there instead of from frame-private modules.
5. **The iframe stays the only integration.** Publishing the frame makes its
   source auditable; it does not make it a host-page component. Rendering it in
   a host's DOM remains rejected (ADR 0001: the host could patch the checks).
   The package README says so, and the mount entry guards against it.
6. **No private dependency.** `@xochi/widget` builds from public packages only:
   this repo's CI has no registry credential (ADR 0002 Order step 5). Every
   frame import of xochi's private `@xochi/shared` is replaced first.

## Order

1. Publish, or rule frame-only, each symbol the frame takes from
   `@xochi/shared` (xochi-sdk#98).
2. `packages/widget` scaffold; move the frame source with its tests.
3. First `widget-v0.1.0` publish.
4. `xochi-widget` `/embed` mounts the published package; its frame source is
   deleted. The configurator imports frame semantics from `@xochi/widget`.

## Consequences

- One PR can change widget-lib, client and the frame together, and one
  release train carries them.
- React, wagmi, viem and the wallet connectors become dependencies of a public
  package. Hosts that only embed install widget-lib, which stays dependency-free.
- `xochi-widget` shrinks to the website; its review history for the frame
  stays there.
- Until step 4, frame changes still land in `xochi-widget`; issues filed here
  meanwhile name the `xochi-widget` path they touch.
