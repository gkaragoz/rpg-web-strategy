# UI

- **i18n**: `t('area.key')`, tables in `src/i18n/*.ts` (`en` + `tr`), parity enforced by `i18n.test.ts`. Language is stored in localStorage, switching reloads the page.
- **Home page** (`MenuScreen` in `src/app/online/screens.ts`): shown at start and after leaving any online screen; four cards: Your own simulation (leads to the studio), Host a lobby, Join with a code, Watch.
- **Language picker** (`src/app/langPicker.ts`): fixed bottom-right listbox with SVG flags (United Kingdom / Türkiye) and country names. On phones it shows flag + chevron only.
- **Bottom stack** (`bottomStack.ts`): polls the studio dock / battle HUD and publishes `--bar-h`, `--lp-w`, `--lp-h`, `--lp-lift`, `--lp-side` on `<html>` so the picker and the online badge sit above/next to the bars.
- **Mobile**: `(max-width:760px),(max-height:520px)` layouts use a bottom sheet (`sheet.ts`); touch targets ≥ 40 px; respect `env(safe-area-inset-*)`.
- **Battle bar** (`battle.ts`, `buildTeamBar`/`updateHud`): one segment per team, width = hp / total hp; hover/focus/tap sets the focus team, whose own soldiers are outlined (white) (`UnitView.setOutline` with `render/outlineFilter.ts` for detailed battles, silhouette layer in `MassRenderer` for crowds).
- **Damage meter** (`dpsMeter.ts`): tabs per team, rows per unit type from `sim.meter` (damage per team x kind, filled in `Battle.damage()`, shared with the worker through `Shared.meter`), thumbnails from `renderIcon`; the final scoreboard in `battle.ts` (`scoreboard()`) uses the same data plus kills per team.
- **Map picker minimaps** (`minimap.ts`): cached by recipe+seed+size and generated one per frame, visible cards first.
- **Unit gallery** (`unitGallery.ts`): static icons baked in `main.ts`; `UnitPreview` (`unitPreview.ts`) adds looping attack animations on visible cards from pre-rendered sprite sheets plus Canvas2D strike overlays (`previewOverlay.ts`). The card list can be sorted (cost, health, damage per hit, DPS, range, speed, name; ascending/descending) via `gallerySort.ts`; the sorted stat's bar is highlighted.
- Styles: `src/app/studio.css`.
