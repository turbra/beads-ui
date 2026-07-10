import { describe, expect, test, vi } from 'vitest';
import { bootstrap } from './main.js';

if (typeof HTMLDialogElement !== 'undefined') {
  const proto = /** @type {any} */ (HTMLDialogElement.prototype);
  if (typeof proto.showModal !== 'function') {
    proto.showModal = function showModal() {
      this.setAttribute('open', '');
    };
    proto.close = function close() {
      this.removeAttribute('open');
    };
  }
}

vi.mock('./ws.js', () => ({
  createWsClient: () => ({
    async send() {
      return null;
    },
    on() {
      return () => {};
    },
    onConnection() {
      return () => {};
    },
    close() {},
    getState() {
      return 'open';
    }
  })
}));

/**
 * @param {EventTarget} target
 * @param {string} key
 */
function pressKey(target, key) {
  const event = new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true
  });
  target.dispatchEvent(event);
  return event;
}

describe('keyboard shortcut help', () => {
  test('discovers help and scopes global shortcuts accessibly', async () => {
    window.localStorage.clear();
    window.location.hash = '#/issues';
    document.body.innerHTML = `
      <header class="app-header">
        <div class="header-actions">
          <button id="shortcut-help-btn" aria-haspopup="dialog">Help</button>
          <button id="new-issue-btn">New issue</button>
        </div>
      </header>
      <main id="app"></main>
    `;
    const root = /** @type {HTMLElement} */ (document.getElementById('app'));
    bootstrap(root);
    for (let index = 0; index < 8; index += 1) {
      await Promise.resolve();
    }

    const help_button = /** @type {HTMLButtonElement} */ (
      document.getElementById('shortcut-help-btn')
    );
    help_button.focus();
    help_button.click();

    const dialog = /** @type {HTMLDialogElement} */ (
      document.getElementById('shortcut-help-dialog')
    );
    expect(dialog.hasAttribute('open')).toBe(true);
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-labelledby')).toBe('shortcut-help-title');
    expect(dialog.getAttribute('aria-describedby')).toBe(
      'shortcut-help-description'
    );
    expect(dialog.textContent).toContain('Ctrl');
    expect(dialog.textContent).toContain('Focus search on the Issues view');
    expect(dialog.textContent).toContain('Close the current dialog');
    expect(dialog.textContent).toContain('Move between rendered rows');
    expect(dialog.textContent).toContain('Move between cards in a column');
    expect(dialog.textContent).toContain('nearest non-empty column');

    const help_close = /** @type {HTMLButtonElement} */ (
      dialog.querySelector('.shortcut-help__close')
    );
    expect(document.activeElement).toBe(help_close);
    const modal_slash = pressKey(help_close, '/');
    expect(modal_slash.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(help_close);

    const escape = pressKey(help_close, 'Escape');
    expect(escape.defaultPrevented).toBe(true);
    expect(dialog.hasAttribute('open')).toBe(false);
    expect(document.activeElement).toBe(help_button);

    const textarea = document.createElement('textarea');
    document.body.appendChild(textarea);
    textarea.focus();
    const editable_help = pressKey(textarea, '?');
    expect(editable_help.defaultPrevented).toBe(false);
    expect(dialog.hasAttribute('open')).toBe(false);
    expect(document.activeElement).toBe(textarea);

    help_button.focus();
    const help_shortcut = pressKey(help_button, '?');
    expect(help_shortcut.defaultPrevented).toBe(true);
    expect(dialog.hasAttribute('open')).toBe(true);
    pressKey(help_close, 'Escape');

    help_button.focus();
    const search_shortcut = pressKey(help_button, '/');
    const search = /** @type {HTMLInputElement} */ (
      document.getElementById('issues-search')
    );
    expect(search_shortcut.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(search);

    textarea.focus();
    const editable_slash = pressKey(textarea, '/');
    expect(editable_slash.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(textarea);

    window.location.hash = '#/board';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    await Promise.resolve();
    help_button.focus();
    const board_slash = pressKey(help_button, '/');
    expect(board_slash.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(help_button);
  });
});
