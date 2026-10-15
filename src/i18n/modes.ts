import type { StringTable } from './types';

/** Strings of the game modes (picker cards, rules, objective strip). Every key must exist in both languages (checked by i18n.test.ts). */
export const modes: StringTable = {
  en: {
    'mode.label': 'Game mode',
    'mode.aria': 'Game mode',
    'mode.classic.name': 'Classic',
    'mode.classic.rule': 'The last team standing wins.',
    'mode.hill.name': 'King of the Hill',
    'mode.hill.rule': 'Hold the control points: every point you own scores 1 per second. First to {target} points wins.',
    'mode.hud.aria': 'Objective',
    'mode.hud.hill.points': '{n} / {total} points held',
    'mode.hud.hill.time': '{time} left',
    'mode.hud.hill.target': 'First to {target}',
    'mode.hud.hill.score': 'Team {n}: {score} points',
    'mode.result.score': 'Points',
  },
  tr: {
    'mode.label': 'Oyun modu',
    'mode.aria': 'Oyun modu',
    'mode.classic.name': 'Klasik',
    'mode.classic.rule': 'Ayakta kalan son takım kazanır.',
    'mode.hill.name': 'Tepenin Kralı',
    'mode.hill.rule': 'Kontrol noktalarını tut: sahip olduğun her nokta saniyede 1 puan getirir. İlk {target} puana ulaşan kazanır.',
    'mode.hud.aria': 'Hedef',
    'mode.hud.hill.points': '{n} / {total} nokta elde',
    'mode.hud.hill.time': '{time} kaldı',
    'mode.hud.hill.target': 'İlk {target} puan',
    'mode.hud.hill.score': 'Takım {n}: {score} puan',
    'mode.result.score': 'Puan',
  },
};
