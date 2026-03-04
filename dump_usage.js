const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const contexts = browser.contexts();
  let page = null;
  for (const ctx of contexts) {
    for (const p of ctx.pages()) {
      if (p.url().includes('claude.ai')) { page = p; break; }
    }
    if (page) break;
  }
  if (!page) { console.log('No claude.ai tab found'); process.exit(1); }

  await page.goto('https://claude.ai/settings/usage', { waitUntil: 'load' });
  await page.waitForTimeout(5000);

  const data = await page.evaluate(() => {
    const results = [];
    document.querySelectorAll('*').forEach(el => {
      const t = el.innerText ? el.innerText.trim() : '';
      if (!t || t.length > 300) return;
      if (t.includes('session') || t.includes('Session') || t.includes('Weekly') || t.includes('weekly') ||
          t.includes('%') || t.includes('Resets') || t.includes('used') || t.includes('All models') ||
          t.includes('limit') || t.includes('Usage')) {
        results.push({ tag: el.tagName, cls: (el.className || '').substring(0, 80), text: t.substring(0, 200) });
      }
    });
    return results;
  });

  console.log(JSON.stringify(data, null, 2));
  await browser.close();
})();
