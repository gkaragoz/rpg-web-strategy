# UI

- **i18n**: `t('area.key')`, tables in `src/i18n/*.ts` (`en` + `tr`), parity enforced by `i18n.test.ts`. Language is stored in localStorage, switching reloads the page.
- **Language picker** (`src/app/langPicker.ts`): fixed bottom-right listbox with SVG flags (United Kingdom / Türkiye) and country names. On phones it shows flag + chevron only.
- **Bottom stack** (`bottomStack.ts`): polls the studio dock / battle HUD and publishes `--bar-h`, `--lp-w`, `--lp-h`, `--lp-lift`, `--lp-side` on `<html>` so the picker and the online badge sit above/next to the bars.
- **Mobile**: `(max-width:760px),(max-height:520px)` layouts use a bottom sheet (`sheet.ts`); touch targets ≥ 40 px; respect `env(safe-area-inset-*)`.
- **Unit gallery** (`unitGallery.ts`): static icons baked in `main.ts`; `UnitPreview` (`unitPreview.ts`) adds looping attack animations on visible cards from pre-rendered sprite sheets plus Canvas2D strike overlays (`previewOverlay.ts`).
- Styles: `src/app/studio.css`.
