/** Flat string table: dotted keys -> text. `{name}` placeholders are replaced by `t(key, { name })`. */
export type Strings = Record<string, string>;
export interface StringTable {
  en: Strings;
  tr: Strings;
}
