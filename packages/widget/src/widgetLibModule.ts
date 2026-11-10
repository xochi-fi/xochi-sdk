/**
 * Where the widget serves a `@xochi/widget-lib` browser ESM release on its own
 * origin: public/widget-lib/<version>/ holds every version ever shipped
 * (scripts/check-widget-lib-versions.mjs), and the configurator's HTML snippet
 * imports the installed one, so an integrator's page loads no third-party
 * script and an older snippet keeps loading after an upgrade.
 */
export const widgetLibModuleDir = (version: string): string => `widget-lib/${version}`;
