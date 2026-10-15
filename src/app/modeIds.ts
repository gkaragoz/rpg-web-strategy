/** Game modes the UI offers (the ids match `GameModeId` in src/sim/modes). A mode appears here once its rules are implemented. */
export const SELECTABLE_MODES = ['classic', 'hill', 'vip', 'ctf', 'siege'] as const;
export type SelectableMode = (typeof SELECTABLE_MODES)[number];

export const isSelectableMode = (v: unknown): v is SelectableMode => (SELECTABLE_MODES as readonly unknown[]).includes(v);
