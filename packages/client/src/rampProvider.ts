// Copyright (c) 2025-2026 Xochi Contributors
// SPDX-License-Identifier: MIT

import type {
  RampAction,
  RampCommandContext,
  RampIntent,
  RampOffer,
  RampPreview,
  RampSnapshot,
} from "./ramp.js";

/** Trusted-runtime adapter. Private handles must stay inside its implementation. */
export interface RampProvider {
  readonly id: "peer";
  capabilities(request: RampIntent, signal?: AbortSignal): Promise<unknown>;
  normalizeCapabilities(raw: unknown, request: RampIntent): readonly RampOffer[];
  preview(request: RampIntent, offer: RampOffer, signal?: AbortSignal): Promise<RampPreview>;
  approve(preview: RampPreview, context: RampCommandContext): Promise<RampSnapshot>;
  interact(operationId: string, context: RampCommandContext): Promise<RampSnapshot>;
  status(operationId: string): Promise<RampSnapshot>;
  recover(
    operationId: string,
    action: RampAction,
    context: RampCommandContext,
  ): Promise<RampSnapshot>;
}

/** Independently approved, non-atomic route; receives only public operation references. */
export interface XochiRampLeg {
  /** Prepare/review a fresh independent route quote inside the trusted runtime. */
  approve(operationId: string, context: RampCommandContext): Promise<RampSnapshot>;
  /** Non-authorizing reference for the currently approved route quote. */
  quoteId(operationId: string): Promise<string>;
  execute(operationId: string, quoteId: string, context: RampCommandContext): Promise<RampSnapshot>;
  status(operationId: string): Promise<RampSnapshot>;
  recover(
    operationId: string,
    action: RampAction,
    context: RampCommandContext,
  ): Promise<RampSnapshot>;
}
