/**
 * The preview side of the configurator (xochi-fi/xochi-widget#35): the public
 * widget library on a stand-in host page, exactly as an integrator mounts it.
 *
 * The background and the device width describe the HOST, not the widget, so
 * nothing here feeds the widget params or the code: they only change how the
 * preview is looked at.
 */

import { useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from "react";
import {
  createXochiWidget,
  EMBED_FRAME,
  type EmbedParams,
  type XochiWidget,
} from "@xochi/widget-lib";
import {
  BACKDROP_KINDS,
  PHONE_WIDTH,
  PREVIEW_DEVICES,
  type Backdrop,
  type BackdropKind,
  type PreviewDevice,
} from "./previewModel.js";

const BACKDROP_LABEL: Record<BackdropKind, string> = {
  light: "Light",
  dark: "Dark",
  checker: "Checker",
  custom: "Custom",
};

const DEVICE_LABEL: Record<PreviewDevice, string> = {
  desktop: "Desktop",
  phone: `Phone ${PHONE_WIDTH}px`,
};

interface PreviewStageProps {
  /** The frame path, `/embed?...`, for the standalone preview link. */
  path: string;
  /** The same frame parameters in their structured form. */
  params: EmbedParams;
  backdrop: Backdrop;
  onBackdrop: (backdrop: Backdrop) => void;
  device: PreviewDevice;
  onDevice: (device: PreviewDevice) => void;
}

/**
 * Whether the stage can show the phone width, so Desktop and Phone render
 * differently. Below it both shrink to the stage and look the same. Null until
 * measured (and where nothing can measure), which keeps the device choice.
 *
 * The measurement must not depend on the toggle it decides: the toggle stays
 * in the layout either way (see below) and the stage reserves its scrollbar
 * gutter, so showing or hiding it can never move the width back across the
 * threshold.
 */
function useFitsPhone(stage: RefObject<HTMLDivElement | null>): boolean | null {
  const [fits, setFits] = useState<boolean | null>(null);
  useLayoutEffect(() => {
    const el = stage.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      // The content box: the stage's width inside its padding and gutter.
      setFits(entry.contentRect.width >= PHONE_WIDTH);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [stage]);
  return fits;
}

export function PreviewStage({
  path,
  params,
  backdrop,
  onBackdrop,
  device,
  onDevice,
}: PreviewStageProps) {
  const backdropName = useId();
  const deviceName = useId();
  const stageRef = useRef<HTMLDivElement>(null);
  const widgetRef = useRef<XochiWidget | null>(null);
  // On a stage narrower than the phone width the frame shrinks to fit, as it
  // would on a host that narrow, so Desktop and Phone would render the same:
  // the toggle is withdrawn and the preview shows that real width. The chosen
  // device is kept (and stays in a shared URL) for when the stage widens.
  const deviceAvailable = useFitsPhone(stageRef) !== false;
  const shown: PreviewDevice = deviceAvailable ? device : "desktop";
  const width = shown === "phone" ? PHONE_WIDTH : EMBED_FRAME.width;

  useEffect(() => {
    const stage = stageRef.current;
    if (stage === null) return;
    const widget = createXochiWidget(stage, {
      params,
      origin: window.location.origin,
      provider: window.ethereum ?? null,
      autoConnect: false,
    });
    widgetRef.current = widget;
    const frame = stage.querySelector("iframe");
    if (frame === null) throw new Error("widget did not mount its preview frame");
    frame.className = "config-stage__frame";
    frame.title = `${EMBED_FRAME.title} preview`;
    return () => {
      widgetRef.current = null;
      widget.destroy();
    };
    // The parameter effect below owns every update after the initial mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    widgetRef.current?.updateParams(params);
  }, [params]);

  useEffect(() => {
    stageRef.current?.querySelector("iframe")?.setAttribute("width", String(width));
  }, [width]);

  return (
    <main className="config-preview">
      <div className="config-preview__bar">
        <fieldset className="config-seg">
          <legend className="config-seg__legend">Background</legend>
          <div className="config-seg__options">
            {BACKDROP_KINDS.filter((kind) => kind !== "custom").map((kind) => (
              <label key={kind} className="config-seg__option">
                <input
                  type="radio"
                  name={backdropName}
                  value={kind}
                  checked={backdrop.kind === kind}
                  onChange={() => onBackdrop({ ...backdrop, kind })}
                />
                <span className={`config-swatch config-swatch--${kind}`} aria-hidden="true" />
                {BACKDROP_LABEL[kind]}
              </label>
            ))}
            <label className="config-seg__option">
              <input
                type="radio"
                name={backdropName}
                value="custom"
                checked={backdrop.kind === "custom"}
                onChange={() => onBackdrop({ ...backdrop, kind: "custom" })}
              />
              {BACKDROP_LABEL.custom}
            </label>
            <input
              type="color"
              className="config-swatch config-swatch--picker"
              aria-label="Custom background colour"
              value={backdrop.custom}
              onChange={(e) => onBackdrop({ kind: "custom", custom: e.target.value })}
            />
          </div>
        </fieldset>

        {/* Always laid out, only hidden: unmounting it would change the bar's
            height and so the stage's, which is what the toggle is decided on. */}
        <fieldset
          className="config-seg"
          disabled={!deviceAvailable}
          style={deviceAvailable ? undefined : { visibility: "hidden" }}
        >
          <legend className="config-seg__legend">Device</legend>
          <div className="config-seg__options">
            {PREVIEW_DEVICES.map((id) => (
              <label key={id} className="config-seg__option">
                <input
                  type="radio"
                  name={deviceName}
                  value={id}
                  checked={device === id}
                  onChange={() => onDevice(id)}
                />
                {DEVICE_LABEL[id]}
              </label>
            ))}
          </div>
        </fieldset>

        <a className="config-preview__open" href={path} target="_blank" rel="noreferrer">
          Open in new tab
          <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
            <path
              d="M5 2H2v8h8V7M7 2h3v3M10 2 5.5 6.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </a>
      </div>

      <div
        ref={stageRef}
        className={`config-stage config-stage--${backdrop.kind}`}
        style={backdrop.kind === "custom" ? { backgroundColor: backdrop.custom } : undefined}
        role="region"
        aria-label="Host page"
      />
    </main>
  );
}
