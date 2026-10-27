const { chromium } = require('playwright');
const { pathToFileURL } = require('node:url');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.PID_BROWSER_CHANNEL ? {channel:process.env.PID_BROWSER_CHANNEL} : {}) });
  const checks = [], layouts = [], errors = [];
  const url = pathToFileURL(path.join(__dirname, 'pid-lab.html')).href;
  try {
    const context = await browser.newContext({ viewport: { width: 1560, height: 1120 }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(url);
    await page.waitForFunction(() => window.PIDLocale && window.__pidLab?.comparison);
    const snapshot = () => page.evaluate(() => {
      const app = window.__pidLab, cmp = app.comparison(), result = app.current(), ref = app.reference();
      return { config: app.config(), form: result.form, stats: result.stats,
        currentValues: result.records.map(r => [r.t, r.y, r.u, r.P, r.I, r.D]),
        cursor: document.getElementById('time-cursor').value,
        active: cmp.active, enabled: cmp.enabled, A: cmp.A, B: cmp.B,
        reference: ref ? { config: ref.result.config, form: ref.form, stats: ref.result.stats } : null,
        selected: ['mode', 'form', 'preset', 'view-mode', 'horizon'].map(id => [id, document.getElementById(id).value]),
        hiddenSeries: [...document.querySelectorAll('.chart-legend button[aria-pressed="false"]')].map(e => e.parentElement.id) };
    });
    async function slide(id, value) {
      const revision = await page.evaluate(() => window.__pidLab.revision());
      await page.locator('#' + id).fill(String(value));
      await page.waitForFunction(old => window.__pidLab.revision() > old, revision);
    }
    async function switchLanguage(lang) {
      await page.locator('#language-select').selectOption(lang);
      await page.waitForFunction(value => document.documentElement.lang === value && window.PIDLocale.language() === value, lang);
      assert.equal(await page.locator('#language-select').inputValue(), lang);
    }
    async function assertEnglish(scope = 'body') {
      const remains = await page.locator(scope).evaluate(root => {
        const japanese = /[\u3040-\u30ff\u3400-\u9fff]/u;
        const visible = e => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
        const out = [], walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let n;
        while ((n = walker.nextNode())) {
          const parent = n.parentElement;
          if (!parent || parent.closest('script,style,#language-select,#language-hints') || !japanese.test(n.textContent)) continue;
          const range = document.createRange(); range.selectNodeContents(n);
          if (visible(parent) && range.getClientRects().length) out.push({ type: 'text', text: n.textContent.trim(), tag: parent.tagName, id: parent.id });
        }
        for (const e of root.querySelectorAll('[aria-label],[title]')) {
          if (e.closest('#language-select,#language-hints') || !visible(e)) continue;
          for (const a of ['aria-label', 'title']) if (japanese.test(e.getAttribute(a) || '')) out.push({ type: a, text: e.getAttribute(a), id: e.id });
        }
        for (const e of root.querySelectorAll('select:not(#language-select)')) if (visible(e)) {
          for (const option of e.options) if (japanese.test(option.textContent)) out.push({ type: 'option', text: option.textContent, id: e.id });
        }
        return out;
      });
      assert.deepEqual(remains, [], 'Untranslated rendered content: ' + JSON.stringify(remains));
    }

    assert.equal(await page.locator('html').getAttribute('lang'), 'en');
    assert.equal(await page.locator('#language-select').inputValue(), 'en');
    await assertEnglish();
    checks.push('A fresh visit starts in English while the permanent multilingual language-setting hints remain visible');
    await page.locator('.app-header').screenshot({path:path.join(__dirname,'language-settings-desktop.png')});
    await switchLanguage('ja');
    await page.locator('#save-reference').click();
    await slide('Kp', 3);
    await page.locator('#form').selectOption('incremental');
    await page.locator('#view-mode').selectOption('compare');
    await page.locator('#edit-a').click();
    await slide('deadTime', 20);
    await page.locator('#edit-b').click();
    await page.locator('#time-cursor').fill('35');
    await page.locator('#temperature-legend button').first().click();
    await page.locator('.explanation-detail').last().evaluate(e => e.open = true);
    const before = await snapshot();
    await switchLanguage('en');
    assert.deepEqual(await snapshot(), before);
    assert.match(await page.locator('h1').innerText(), /PID/i);
    assert.match(await page.locator('#controller-heading').innerText(), /control/i);
    assert.match(await page.locator('#calculation').innerText(), /previous/i);
    await assertEnglish();
    checks.push('English covers static help, options, accessibility labels, charts, and complete carried-state calculations without changing A/B settings, reference, cursor, or data');

    await slide('Ti', 120);
    await page.locator('#next-step').click();
    await page.locator('#edit-a').click();
    await page.locator('#mode').selectOption('P');
    await assertEnglish();
    assert.match(await page.locator('#derived-gains').innerText(), /Ki = 0/);
    await page.locator('#mode').selectOption('PI');
    await assertEnglish();
    await page.locator('#edit-b').click();
    await page.locator('#mode').selectOption('PID');
    await assertEnglish();
    checks.push('Subsequent slider, controller mode, active case, and time changes keep newly generated content in English');

    await page.locator('#temperature-b-chart').scrollIntoViewIfNeeded();
    const hit = await page.locator('#temperature-b-chart [data-chart-hit]').boundingBox();
    await page.mouse.move(hit.x + hit.width * .3, hit.y + hit.height * .5);
    assert.equal(await page.locator('#chart-tooltip').isVisible(), true);
    await assertEnglish('#chart-tooltip');
    await page.mouse.move(0, 0);
    const enState = await snapshot();
    await switchLanguage('ja');
    assert.deepEqual(await snapshot(), enState);
    assert.match(await page.locator('#calculation').innerText(), /前回/);
    assert.match(await page.locator('#controller-heading').innerText(), /制御器/);
    await switchLanguage('en');
    await assertEnglish();
    checks.push('Tooltips translate; Japanese/English round trips preserve the selected state and equations');

    await page.locator('#play').click();
    assert.equal(await page.locator('#play').getAttribute('aria-pressed'), 'true');
    assert.match(await page.locator('#play').innerText(), /pause/i);
    const timeBefore = Number(await page.locator('#time-cursor').inputValue());
    await switchLanguage('ja');
    assert.equal(await page.locator('#play').getAttribute('aria-pressed'), 'true');
    assert.match(await page.locator('#play').innerText(), /一時停止/);
    await switchLanguage('en');
    await page.waitForFunction(t => Number(document.getElementById('time-cursor').value) > t, timeBefore);
    assert.match(await page.locator('#play').innerText(), /pause/i);
    await page.locator('#play').click();
    assert.match(await page.locator('#play').innerText(), /play/i);
    checks.push('Switching language while playing keeps playback active and updates its current button label');

    await page.locator('#time-cursor').fill('35');
    await page.screenshot({ path: path.join(__dirname, 'english-desktop.png'), fullPage: true });
    for (const width of [1560, 1024, 736, 360, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.waitForTimeout(200);
      const result = await page.evaluate(() => {
        const visible = e => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden';
        const pairs = ['temperature', 'output', 'terms'].map(id => {
          const a = document.querySelector('#' + id + '-chart svg').getBoundingClientRect();
          const b = document.querySelector('#' + id + '-b-chart svg').getBoundingClientRect();
          return { id, leftTop: a.top, rightTop: b.top, sideBySide: Math.abs(a.top - b.top) < 2 && b.left > a.left };
        });
        const clipped = [...document.querySelectorAll('svg text')].filter(visible).map(e => ({
          parent: e.closest('svg').getBoundingClientRect(), rect: e.getBoundingClientRect(), text: e.textContent
        })).filter(x => x.rect.left < x.parent.left - 1 || x.rect.right > x.parent.right + 1).map(x => x.text);
        return { width: innerWidth, scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth, pairs, clipped };
      });
      assert.ok(result.scroll <= result.client + 1, JSON.stringify(result));
      assert.deepEqual(result.clipped, [], JSON.stringify(result));
      if (width >= 736) assert.ok(result.pairs.every(p => p.sideBySide), JSON.stringify(result));
      const header = await page.locator('#language-select').boundingBox();
      assert.ok(header && header.width > 0 && header.x >= 0 && header.x + header.width <= width + 1);
      await assertEnglish(); layouts.push(result);
    }
    await page.screenshot({ path: path.join(__dirname, 'english-mobile.png'), fullPage: true });
    await page.locator('.app-header').screenshot({path:path.join(__dirname,'language-settings-mobile.png')});
    checks.push('English fits at 320/360/736/1024/1560px; matching comparison plots remain vertically aligned and the language selector stays reachable');

    await page.locator('#view-mode').selectOption('single');
    await assertEnglish();
    assert.match(await page.locator('#reference-label').innerText(), /reference/i);
    await page.locator('#form').selectOption('position'); await assertEnglish();
    await page.locator('#preset').selectOption('saturation'); await slide('target', 60); await assertEnglish();
    assert.match(await page.locator('#comparison-status').innerText(), /cannot|unreachable|maintain/i);
    checks.push('Single-view references, positional calculations, and unreachable-target feedback translate after leaving comparison');

    assert.equal(await page.evaluate(() => localStorage.getItem('pid-lab-language')), 'en');
    await page.reload();
    await page.waitForFunction(() => window.__pidLab && document.documentElement.lang === 'en');
    await page.locator('.explanation-detail').last().evaluate(e => e.open = true);
    await assertEnglish();
    await switchLanguage('ja');
    await page.reload();
    await page.waitForFunction(() => window.__pidLab && document.documentElement.lang === 'ja');
    checks.push('The chosen language survives reload in both directions');

    const unknownContext = await browser.newContext();
    await unknownContext.addInitScript(() => localStorage.setItem('pid-lab-language', 'unsupported-language'));
    const unknown = await unknownContext.newPage(); unknown.on('pageerror', e => errors.push(e.message));
    await unknown.goto(url); await unknown.waitForFunction(() => window.__pidLab && window.PIDLocale);
    assert.equal(await unknown.locator('html').getAttribute('lang'), 'en');
    assert.equal(await unknown.locator('#language-select').inputValue(), 'en');
    await unknownContext.close();
    checks.push('An unsupported saved language falls back to English');

    const blockedContext = await browser.newContext();
    await blockedContext.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new DOMException('Disabled for test', 'SecurityError'); } });
    });
    const blocked = await blockedContext.newPage(); blocked.on('pageerror', e => errors.push(e.message));
    await blocked.goto(url); await blocked.waitForFunction(() => window.__pidLab && window.PIDLocale);
    assert.equal(await blocked.locator('html').getAttribute('lang'), 'en');
    await blocked.locator('#language-select').selectOption('ja');
    await blocked.waitForFunction(() => document.documentElement.lang === 'ja');
    await blocked.locator('#language-select').selectOption('en');
    await blocked.waitForFunction(() => document.documentElement.lang === 'en');
    assert.match(await blocked.locator('#controller-heading').innerText(), /control/i);
    assert.equal(await blocked.locator('#app-error').isVisible(), false);
    await blockedContext.close();
    checks.push('When browser storage is unavailable, English is the default and language switching still works without a runtime error');

    assert.deepEqual(errors, []);
    const report = { checks, layouts, errors };
    fs.writeFileSync(path.join(__dirname, 'localization-verification.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
