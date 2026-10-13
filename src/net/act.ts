/**
 * Stable code of the panel the player currently has open (shown next to the cursor as "Name (action)").
 * Codes: 'unitPicker', 'mapPicker', 'lobbySettings', 'unitSettings'. The code travels over the network and each
 * receiver translates it into its own language (`online.act.<code>`). Panels set it when opened and clear it when closed.
 */
export const act: { text: string | undefined } = { text: undefined };

/** Helper that sets the action code while a <dialog> is open and clears it on close. */
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
