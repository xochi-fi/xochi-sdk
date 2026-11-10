/**
 * The code the configurator hands an integrator (xochi-fi/xochi-widget#36),
 * one per Get code tab. HTML loads the exact-version browser ESM module the
 * widget's own origin serves (no third-party script on the integrator's page);
 * React uses the npm package; URL is the raw-frame fallback.
 */

import {
  EMBED_PARAM,
  embedUrl,
  encodeEmbedParams,
  parseEmbedParams,
  type EmbedParams,
} from "@xochi/widget-lib";
import widgetLibPackage from "@xochi/widget-lib/package.json";
import { widgetLibModuleDir } from "../../widgetLibModule.js";

/** The browser ESM entry served beside the frame at `origin`. */
export const widgetLibModuleUrl = (origin: string): string =>
  `${origin}/${widgetLibModuleDir(widgetLibPackage.version)}/index.js`;

export type CodeFormat = "html" | "react" | "url";

export const CODE_FORMATS: readonly { id: CodeFormat; tab: string; label: string }[] = [
  { id: "html", tab: "HTML", label: "HTML code" },
  { id: "react", tab: "React", label: "React code" },
  { id: "url", tab: "URL", label: "Embed URL" },
];

/**
 * The frame parameters in `params` (every `EMBED_PARAM` field the preview
 * uses), and nothing else, however the object was assembled: a stray key never
 * reaches the integrator's code, and the strict encoder never sees one.
 */
function frameParams(params: EmbedParams): EmbedParams {
  return Object.fromEntries(
    Object.entries(params).filter(([key]) =>
      Object.prototype.hasOwnProperty.call(EMBED_PARAM, key),
    ),
  ) as EmbedParams;
}

/** A JavaScript object literal of the frame parameters, in canonical form. */
function paramsLiteral(params: EmbedParams, indent: string): string {
  const entries = Object.entries(parseEmbedParams(encodeEmbedParams(frameParams(params))));
  if (entries.length === 0) return "{}";
  return [
    "{",
    ...entries.map(
      ([key, value], index) =>
        `${indent}  ${key}: ${JSON.stringify(value)}${index === entries.length - 1 ? "" : ","}`,
    ),
    `${indent}}`,
  ].join("\n");
}

/** The HTML and module code to paste into an integrator's page. */
export function htmlSnippet(origin: string, params: EmbedParams): string {
  return [
    '<div id="xochi-swap"></div>',
    '<script type="module">',
    `  import { createXochiWidget } from "${widgetLibModuleUrl(origin)}";`,
    "",
    '  const widget = createXochiWidget(document.getElementById("xochi-swap"), {',
    `    origin: ${JSON.stringify(origin)},`,
    `    params: ${paramsLiteral(params, "    ")},`,
    "  });",
    "</script>",
  ].join("\n");
}

/** A React component with the same mount and complete unmount cleanup. */
export function reactSnippet(origin: string, params: EmbedParams): string {
  return [
    'import { useEffect, useRef } from "react";',
    'import { createXochiWidget } from "@xochi/widget-lib";',
    "",
    "export function XochiSwap() {",
    "  const container = useRef<HTMLDivElement>(null);",
    "",
    "  useEffect(() => {",
    "    if (container.current === null) return;",
    "    const widget = createXochiWidget(container.current, {",
    `      origin: ${JSON.stringify(origin)},`,
    `      params: ${paramsLiteral(params, "      ")},`,
    "    });",
    "    return () => widget.destroy();",
    "  }, []);",
    "",
    "  return <div ref={container} />;",
    "}",
  ].join("\n");
}

/** The code for one tab, for the public widget at `origin`. */
export function codeFor(format: CodeFormat, origin: string, params: EmbedParams): string {
  switch (format) {
    case "html":
      return htmlSnippet(origin, params);
    case "react":
      return reactSnippet(origin, params);
    case "url":
      return embedUrl(origin, frameParams(params));
  }
}
