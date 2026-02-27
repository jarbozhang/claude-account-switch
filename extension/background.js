'use strict';

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== 'SET_SESSION_KEY') return;

  chrome.cookies.set({
    url: 'https://claude.ai',
    name: 'sessionKey',
    value: msg.sessionKey,
    domain: '.claude.ai',
    path: '/',
    secure: true,
    httpOnly: true,
    sameSite: 'lax',
    expirationDate: Math.floor(Date.now() / 1000) + 365 * 24 * 3600
  }, (cookie) => {
    if (chrome.runtime.lastError) {
      sendResponse({ ok: false, error: chrome.runtime.lastError.message });
    } else {
      sendResponse({ ok: !!cookie });
    }
  });

  return true; // keep channel open for async sendResponse
});
