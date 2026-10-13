/**
 * Oyuncunun o an actigi panelin adi (imlecin yaninda "Ad (eylem)" olarak gosterilir).
 * Paneller acilinca ayarlar, kapaninca temizler.
 */
export const act: { text: string | undefined } = { text: undefined };

/** <dialog> acilip kapanirken eylem metnini ayarlayan yardimci. */
export function trackDialog(dlg: HTMLDialogElement, text: string): { open(): void } {
  dlg.addEventListener('close', () => {
    if (act.text === text) act.text = undefined;
  });
  return {
    open() {
      act.text = text;
    },
  };
}
