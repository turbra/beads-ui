/**
 * Create and manage the keyboard shortcut help dialog.
 *
 * @param {HTMLElement} mount_element
 * @returns {{ open: () => void, close: () => void }}
 */
export function createShortcutHelpDialog(mount_element) {
  const dialog = /** @type {HTMLDialogElement} */ (
    document.createElement('dialog')
  );
  dialog.id = 'shortcut-help-dialog';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'shortcut-help-title');
  dialog.setAttribute('aria-describedby', 'shortcut-help-description');
  dialog.innerHTML = `
    <section class="shortcut-help" aria-label="Keyboard shortcuts">
      <header class="shortcut-help__header">
        <div>
          <h2 id="shortcut-help-title">Keyboard shortcuts</h2>
          <p id="shortcut-help-description">Use these shortcuts when focus is outside an editable field.</p>
        </div>
        <button type="button" class="shortcut-help__close" aria-label="Close shortcut help">×</button>
      </header>
      <div class="shortcut-help__body">
        <h3>Global</h3>
        <dl class="shortcut-help__list">
          <div><dt><kbd>Ctrl</kbd>/<kbd>Cmd</kbd> + <kbd>N</kbd></dt><dd>Create a new issue</dd></div>
          <div><dt><kbd>/</kbd></dt><dd>Focus search on the Issues view</dd></div>
          <div><dt><kbd>?</kbd></dt><dd>Open this shortcut help</dd></div>
          <div><dt><kbd>Esc</kbd></dt><dd>Close the current dialog or cancel an inline edit</dd></div>
        </dl>

        <h3>Issues table</h3>
        <dl class="shortcut-help__list">
          <div><dt><kbd>↑</kbd> / <kbd>↓</kbd></dt><dd>Move between rendered rows or the same column in adjacent rows</dd></div>
          <div><dt><kbd>Enter</kbd></dt><dd>Open the selected issue or activate the focused cell control</dd></div>
        </dl>

        <h3>Board</h3>
        <dl class="shortcut-help__list">
          <div><dt><kbd>↑</kbd> / <kbd>↓</kbd></dt><dd>Move between cards in a column</dd></div>
          <div><dt><kbd>←</kbd> / <kbd>→</kbd></dt><dd>Move to the nearest non-empty column</dd></div>
          <div><dt><kbd>Enter</kbd> / <kbd>Space</kbd></dt><dd>Open the focused card</dd></div>
        </dl>
      </div>
    </section>
  `;
  mount_element.appendChild(dialog);

  const close_button = /** @type {HTMLButtonElement} */ (
    dialog.querySelector('.shortcut-help__close')
  );
  /** @type {HTMLElement | null} */
  let previous_focus = null;

  function restoreFocus() {
    if (previous_focus?.isConnected) {
      previous_focus.focus();
    }
    previous_focus = null;
  }

  function close() {
    try {
      if (typeof dialog.close === 'function') {
        dialog.close();
      } else {
        dialog.removeAttribute('open');
      }
    } catch {
      dialog.removeAttribute('open');
    }
    restoreFocus();
  }

  function open() {
    if (dialog.hasAttribute('open')) {
      close_button.focus();
      return;
    }
    previous_focus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    try {
      if (typeof dialog.showModal === 'function') {
        dialog.showModal();
      } else {
        dialog.setAttribute('open', '');
      }
    } catch {
      dialog.setAttribute('open', '');
    }
    close_button.focus();
  }

  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    close();
  });
  dialog.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  });
  dialog.addEventListener('mousedown', (event) => {
    if (event.target === dialog) {
      event.preventDefault();
      close();
    }
  });
  close_button.addEventListener('click', close);

  return { open, close };
}
