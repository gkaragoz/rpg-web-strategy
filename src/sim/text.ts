/**
 * Text lookup for the few places where the simulation data exposes UI strings (classic unit names, stat labels). The sim must not
 * import the UI language module, so the app installs its `t()` here at startup (src/i18n.ts); until then keys are returned as is.
 */
let translate: (key: string) => string = (key) => key;

export function setTranslator(fn: (key: string) => string): void {
  translate = fn;
}

export function simText(key: string): string {
  return translate(key);
}
