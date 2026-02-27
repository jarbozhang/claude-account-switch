'use strict';

(function () {
  const el = document.querySelector('#session-key-data');
  if (!el) return;

  const sessionKey = el.dataset.key;
  if (!sessionKey) return;

  chrome.runtime.sendMessage({ type: 'SET_SESSION_KEY', sessionKey }, (resp) => {
    if (resp && resp.ok) {
      document.title = 'COOKIE_SET_OK';
    } else {
      document.title = 'COOKIE_SET_FAIL';
    }
  });
})();
