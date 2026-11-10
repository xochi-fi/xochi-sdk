/**
 * Configurator (xochi-fi/xochi-widget#21, #35, #36, #37, #47, #48)
 *
 * The integrator-facing page at `/`: a settings list on one side (a row per
 * section, each drilling into its options), a live preview of the real frame on
 * a stand-in host page on the other, and the embed code. Every option is a frame URL
 * parameter (src/pages/trade/embedParams.ts), and every control is built from
 * the capability matrix the frame itself reads, so it only offers routes the
 * solver fills. Options that are not backed by a shipped slice are absent, not
 * disabled.
 *
 * The configuration lives in one resolved value (`resolveEmbedDefaults`, the
 * same function the frame runs on load), and the preview params, every Get code
 * format and the Developer parameters are all written from it by `embedOverrides`,
 * so the code reproduces the preview by construction. The page keeps the same
 * options in its own URL (configurator/configuratorUrl.ts), so a configuration
 * is shared by its address.
 *
 * This component owns the state and the layout. Each section's controls are a
 * component in configurator/, the Developer draft is `useParamsDraft`, and the
 * page URL is `useConfiguratorUrl`.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useCapabilities } from "../hooks/useCapabilities.js";
import {
  embedOffer,
  embedOverrides,
  explainEmbedDefaults,
  restrictOffer,
  type EmbedAllowLists,
  type EmbedDefaults,
  type FrameParams,
} from "./trade/embedParams.js";
import {
  normalizeEmbedCode,
  EMBED_FRAME,
  EMBED_PATH,
  encodeEmbedParams,
  parseEmbedHeight,
  type EmbedLayout,
  type EmbedLock,
  type EmbedParams,
  type EmbedSettlement,
  type EmbedTheme,
  type EmbedAllowField,
  EMBED_ALLOW_FIELDS,
  EMBED_LOCKS,
} from "@xochi/widget-lib";
import { PreviewStage } from "./configurator/PreviewStage.js";
import type { Backdrop, PreviewDevice } from "./configurator/previewModel.js";
import { SettingsPanel, SettingsRow } from "./configurator/Settings.js";
import { CodeDock } from "./configurator/CodeDock.js";
import { configuratorSearch } from "./configurator/configuratorUrl.js";
import { useConfiguratorUrl, useOpenedConfiguration } from "./configurator/useConfiguratorUrl.js";
import { paramsText } from "./configurator/paramsDraft.js";
import { useParamsDraft } from "./configurator/useParamsDraft.js";
import { RouteSection, routeSummary } from "./configurator/RouteSection.js";
import type { RouteChoice } from "./configurator/routePicks.js";
import { PrivacySection } from "./configurator/PrivacySection.js";
import { DeveloperSection } from "./configurator/DeveloperSection.js";
import { AppearanceSection, THEME_PRESET } from "./configurator/AppearanceSection.js";
import { LayoutSection } from "./configurator/LayoutSection.js";
import { AllowedAssetsSection } from "./configurator/AllowedAssetsSection.js";
import { IntegrationSection, integrationSummary } from "./configurator/IntegrationSection.js";
import { SharedLinkBanner, sharedPresets } from "./configurator/SharedLinkBanner.js";
import { WhatUsersSee } from "./configurator/WhatUsersSee.js";

/** Quiet time after the last change before the preview reloads. */
export const PREVIEW_DEBOUNCE_MS = 400;

type SectionId =
  | "route"
  | "assets"
  | "privacy"
  | "appearance"
  | "layout"
  | "integration"
  | "developer";

const SECTION_TITLE: Record<SectionId, string> = {
  route: "Route",
  assets: "Allowed assets",
  privacy: "Privacy",
  appearance: "Appearance",
  layout: "Layout",
  integration: "Integration",
  developer: "Developer",
};

/**
 * Every option the frame opens on, spelled out, except the amount, the
 * height and the codes (held as typed). A control change starts from this, so
 * it keeps every option it does not touch. Typed so that a new frame option
 * fails to compile here until it is carried.
 */
function currentChoice(
  config: EmbedDefaults,
  asked: EmbedParams,
): Required<Omit<FrameParams, "amount" | "height" | "ref" | "promo" | EmbedAllowField>> &
  EmbedAllowLists {
  return {
    fromChainId: config.fromChainId,
    toChainId: config.toChainId,
    sellSymbol: config.fromToken.symbol,
    buySymbol: config.toToken.symbol,
    settlement: config.settlement,
    theme: config.theme,
    layout: config.layout,
    howItWorks: config.howItWorks,
    // Locks and allow-lists stay as asked: one the frame ignores now is kept
    // (and explained) rather than dropped by an unrelated change. An unasked
    // list stays absent, which the Allowed assets boxes read as every option.
    locks: asked.locks ?? [],
    fromChains: asked.fromChains,
    toChains: asked.toChains,
    sellTokens: asked.sellTokens,
    buyTokens: asked.buyTokens,
  };
}

/** The layout in words, for its row: `Swap only, 640px`. */
function layoutSummary(config: EmbedDefaults): string {
  return [
    config.layout === "swap" ? "Swap only" : "Full widget",
    ...(config.howItWorks ? [] : ["no How it works"]),
    config.height === null ? `${EMBED_FRAME.height}px` : `${config.height}px fixed`,
  ].join(", ");
}

export function Configurator() {
  const { capabilities, source, state, isLoading, isFetching, retry } = useCapabilities();
  const offer = useMemo(() => embedOffer(capabilities, state), [capabilities, state]);

  // A shared configurator URL opens on what it carries.
  const opened = useOpenedConfiguration();

  // The route and mode as chosen, and the amount as typed. Resolved together
  // below by the frame's own resolver, so nothing here can drift from what
  // /embed will actually open on.
  const [choice, setChoice] = useState<EmbedParams>(opened.params);
  const [amountText, setAmountText] = useState(opened.params.amount ?? "");
  const [heightText, setHeightText] = useState(
    opened.params.height === undefined ? "" : String(opened.params.height),
  );
  const [refText, setRefText] = useState(opened.params.ref ?? "");
  const [promoText, setPromoText] = useState(opened.params.promo ?? "");

  // How the preview is looked at. Neither reaches the embed URL or the code.
  const [backdrop, setBackdrop] = useState<Backdrop>(opened.backdrop);
  const [device, setDevice] = useState<PreviewDevice>(opened.device);

  // Whether the user has changed anything since the page opened. Until then
  // the page URL is the one that was shared, and is left as it is.
  const [touched, setTouched] = useState(false);

  // The widget presets a shared link carried, shown until dismissed or Reset.
  const [presets, setPresets] = useState(() => sharedPresets(opened.params));

  const { defaults: config, ignored } = useMemo(
    () =>
      explainEmbedDefaults(
        {
          ...choice,
          amount: amountText.trim() === "" ? undefined : amountText.trim(),
          height: parseEmbedHeight(heightText.trim()),
          ref: normalizeEmbedCode(refText) ?? undefined,
          promo: normalizeEmbedCode(promoText) ?? undefined,
        },
        offer,
      ),
    [choice, amountText, heightText, refText, promoText, offer],
  );
  const defaults = useMemo(() => explainEmbedDefaults({}, offer).defaults, [offer]);
  // The route menus offer only what the allow-lists keep.
  const routeOffer = useMemo(
    () =>
      restrictOffer(offer, {
        fromChains: config.fromChains ?? undefined,
        toChains: config.toChains ?? undefined,
        sellTokens: config.sellTokens ?? undefined,
        buyTokens: config.buyTokens ?? undefined,
      }).offer,
    [offer, config.fromChains, config.toChains, config.sellTokens, config.buyTokens],
  );

  // The preview reloads the whole frame, so it waits for a pause in typing.
  // The snippet is written from the same debounced params: what you copy is
  // what the preview is showing.
  const overrides = embedOverrides(config);
  const search = encodeEmbedParams(overrides);
  const path = `${EMBED_PATH}${search}`;
  const [preview, setPreview] = useState({ search, overrides });
  useEffect(() => {
    const timer = setTimeout(() => setPreview({ search, overrides }), PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // `search` is the encoded form of `overrides`: equal searches, equal params.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);
  const previewPath = `${EMBED_PATH}${preview.search}`;

  // The page's own URL follows every option, after the same pause as the
  // preview. Once the user changes anything it follows them on either matrix;
  // an untouched shared URL waits for the live one (see useConfiguratorUrl).
  useConfiguratorUrl(
    configuratorSearch(config, backdrop, device),
    source !== "fallback" || touched,
    PREVIEW_DEBOUNCE_MS,
  );

  const params = useParamsDraft(config, offer, (next) => {
    setChoice(next);
    setAmountText(next.amount ?? "");
    setHeightText(next.height === undefined ? "" : String(next.height));
    setRefText(next.ref ?? "");
    setPromoText(next.promo ?? "");
  });

  // The section drilled into, or null for the list. Going back returns focus
  // to the row that opened it, and tidies the Developer draft.
  const [openSection, setOpenSection] = useState<SectionId | null>(null);
  const rowRefs = useRef<Partial<Record<SectionId, HTMLButtonElement | null>>>({});
  const returnTo = useRef<SectionId | null>(null);
  useEffect(() => {
    if (openSection !== null || returnTo.current === null) return;
    rowRefs.current[returnTo.current]?.focus();
    returnTo.current = null;
  }, [openSection]);
  const closeSection = (): void => {
    returnTo.current = openSection;
    setOpenSection(null);
    params.settle();
  };

  // Resolved defaults include explicit route/privacy parameters. A canonical
  // default draft is not an edit; ignored choices and invalid drafts are.
  const atDefaults =
    Object.keys(ignored).length === 0 &&
    path === `${EMBED_PATH}${encodeEmbedParams(embedOverrides(defaults))}` &&
    amountText.trim() === "" &&
    heightText.trim() === "" &&
    refText.trim() === "" &&
    promoText.trim() === "" &&
    (params.draft.trim() === "" || params.draft === paramsText(defaults));
  const reset = (): void => {
    setTouched(true);
    setChoice({});
    setAmountText("");
    setHeightText("");
    setRefText("");
    setPromoText("");
    params.clear();
    setPresets([]);
  };

  const onRoute = (route: RouteChoice): void => {
    setTouched(true);
    setChoice({ ...currentChoice(config, choice), ...route });
  };
  const onSettlement = (settlement: EmbedSettlement): void => {
    setTouched(true);
    setChoice({ ...currentChoice(config, choice), settlement });
  };
  // The theme is no part of the route, so it keeps the route as asked rather
  // than as resolved: picked while the matrix loads, it must not pin a shared
  // link's route to what the fallback could confirm.
  const onTheme = (theme: EmbedTheme): void => {
    setTouched(true);
    setChoice((prev) => ({ ...prev, theme }));
  };
  const onLayout = (layout: EmbedLayout): void => {
    setTouched(true);
    setChoice((prev) => ({ ...prev, layout }));
  };
  const onHowItWorks = (howItWorks: boolean): void => {
    setTouched(true);
    setChoice((prev) => ({ ...prev, howItWorks }));
  };
  const onLocks = (locks: readonly EmbedLock[]): void => {
    setTouched(true);
    setChoice((prev) => ({ ...prev, locks: EMBED_LOCKS.filter((l) => locks.includes(l)) }));
  };
  const onLists = (lists: EmbedAllowLists): void => {
    setTouched(true);
    setChoice((prev) => ({ ...prev, ...lists }));
  };

  const sections: Record<SectionId, { summary: string; options: ReactNode }> = {
    route: {
      summary: routeSummary(config),
      options: (
        <RouteSection
          offer={routeOffer}
          config={config}
          amountText={amountText}
          onRoute={onRoute}
          onAmount={(text) => {
            setTouched(true);
            setAmountText(text);
          }}
          locks={choice.locks ?? []}
          onLocks={onLocks}
          lockProblem={ignored.locks}
        />
      ),
    },
    assets: {
      summary: EMBED_ALLOW_FIELDS.some((field) => config[field] !== null)
        ? "Restricted"
        : "Every chain and token",
      options: (
        <AllowedAssetsSection
          offer={offer}
          asked={{
            fromChains: choice.fromChains,
            toChains: choice.toChains,
            sellTokens: choice.sellTokens,
            buyTokens: choice.buyTokens,
          }}
          ignored={ignored}
          onLists={onLists}
        />
      ),
    },
    privacy: {
      summary: config.settlement === "stealth" ? "Stealth settlement" : "Public settlement",
      options: (
        <PrivacySection
          config={config}
          capabilities={offer.capabilities}
          capabilityState={state}
          onSettlement={onSettlement}
        />
      ),
    },
    appearance: {
      summary: THEME_PRESET[config.theme].name,
      options: <AppearanceSection theme={config.theme} onTheme={onTheme} />,
    },
    layout: {
      summary: layoutSummary(config),
      options: (
        <LayoutSection
          layout={config.layout}
          onLayout={onLayout}
          howItWorks={config.howItWorks}
          onHowItWorks={onHowItWorks}
          heightText={heightText}
          onHeight={(text) => {
            setTouched(true);
            setHeightText(text);
          }}
        />
      ),
    },
    integration: {
      summary: integrationSummary(config),
      options: (
        <IntegrationSection
          config={config}
          promoText={promoText}
          onPromo={(text) => {
            setTouched(true);
            setPromoText(text);
          }}
          delayMs={PREVIEW_DEBOUNCE_MS}
        />
      ),
    },
    developer: {
      summary: path,
      options: (
        <DeveloperSection
          params={params}
          onEdit={(text) => {
            setTouched(true);
            params.edit(text);
          }}
        />
      ),
    },
  };

  return (
    <div className="configurator">
      <title>Widget configurator | Xochi</title>
      <header className="config-panel__header">
        <div className="config-panel__titlebar">
          <h1 className="config-panel__title">
            <span className="wordmark">Xochi</span> widget
          </h1>
          <button
            type="button"
            className="config-reset"
            onClick={reset}
            disabled={atDefaults}
            title={atDefaults ? "Every option is at its default" : undefined}
          >
            <svg viewBox="0 0 14 14" width="13" height="13" aria-hidden="true">
              <path
                d="M2.5 7a4.5 4.5 0 1 0 1.32-3.18M2.5 2v2.5H5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            Reset
          </button>
        </div>
        <a className="config-panel__affiliate" href="/affiliate">
          Affiliate earnings
        </a>
      </header>
      <aside className="config-panel" aria-label="Widget options">
        {/* On the list only: inside a section it would push the options below
            the Get code dock on a short screen. */}
        {presets.length > 0 && openSection === null ? (
          <SharedLinkBanner presets={presets} onDismiss={() => setPresets([])} />
        ) : null}

        {isLoading ? (
          <p className="config-status" role="status">
            Loading routes...
          </p>
        ) : source === "fallback" ? (
          <div className="config-status config-status--warn" role="status">
            <p>
              Route capabilities couldn't be loaded. Retry before publishing this configuration.
            </p>
            <button
              type="button"
              className="btn btn--secondary btn--sm"
              onClick={retry}
              disabled={isFetching}
            >
              {isFetching ? "Retrying..." : "Retry"}
            </button>
          </div>
        ) : null}

        {openSection === null ? (
          <nav aria-label="Settings">
            <ul className="config-list">
              {(Object.keys(SECTION_TITLE) as SectionId[]).map((id) => (
                <SettingsRow
                  key={id}
                  ref={(el) => {
                    rowRefs.current[id] = el;
                  }}
                  title={SECTION_TITLE[id]}
                  summary={sections[id].summary}
                  onOpen={() => setOpenSection(id)}
                />
              ))}
            </ul>
          </nav>
        ) : (
          <SettingsPanel key={openSection} title={SECTION_TITLE[openSection]} onBack={closeSection}>
            {sections[openSection].options}
          </SettingsPanel>
        )}
      </aside>

      <CodeDock
        origin={window.location.origin}
        params={preview.overrides}
        host={window.location.host}
      />

      <PreviewStage
        path={previewPath}
        params={preview.overrides}
        backdrop={backdrop}
        onBackdrop={(next) => {
          setTouched(true);
          setBackdrop(next);
        }}
        device={device}
        onDevice={(next) => {
          setTouched(true);
          setDevice(next);
        }}
      />

      <WhatUsersSee config={config} />
    </div>
  );
}
