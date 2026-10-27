const { chromium } = require('playwright');
const { pathToFileURL } = require('node:url');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.PID_BROWSER_CHANNEL ? {channel:process.env.PID_BROWSER_CHANNEL} : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: 1560, height: 1120 }, deviceScaleFactor: 1 });
    const errors = [], checks = [], layouts = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(pathToFileURL(path.join(__dirname, 'pid-lab.html')).href);
    await page.waitForFunction(() => typeof window.__pidLab?.comparison === 'function');
    await page.locator('#language-select').selectOption('ja');
    const state = () => page.evaluate(() => {
      const s = window.__pidLab.comparison();
      return { enabled: s.enabled, active: s.active, A: s.A, B: s.B,
        resultA: s.results?.A ? { config: s.results.A.config, form: s.results.A.form, final: s.results.A.stats.finalTemperature } : null,
        resultB: s.results?.B ? { config: s.results.B.config, form: s.results.B.form, final: s.results.B.stats.finalTemperature } : null };
    });
    async function slide(id, value) {
      const before = await page.evaluate(() => window.__pidLab.revision());
      await page.locator('#' + id).fill(String(value));
      await page.waitForFunction(old => window.__pidLab.revision() > old, before);
    }
    async function select(id, value) {
      await page.locator('#' + id).selectOption(value);
      await page.waitForFunction(() => !document.querySelector('#app-error') || document.querySelector('#app-error').hidden);
    }
    async function scales(id) {
      return page.locator('#' + id + '-chart svg').evaluate(e => ({
        min: Number(e.getAttribute('data-y-min')),
        max: Number(e.getAttribute('data-y-max')),
        horizon: Number(e.getAttribute('data-x-max')),
        unit: e.getAttribute('aria-label'),
        present: e.hasAttribute('data-y-min') && e.hasAttribute('data-y-max') && e.hasAttribute('data-x-max')
      }));
    }
    async function assertSharedScales() {
      for (const id of ['temperature', 'output', 'terms']) {
        const a = await scales(id), b = await scales(id + '-b');
        assert.ok(a.present && b.present, id + ' scale audit attributes are required');
        assert.equal(a.min, b.min, id + ' y minimum differs');
        assert.equal(a.max, b.max, id + ' y maximum differs');
        assert.equal(a.horizon, b.horizon, id + ' time domain differs');
        assert.ok(a.max > a.min && a.horizon > 0, id + ' scale is invalid');
      }
    }

    assert.equal((await state()).enabled, false);
    await select('view-mode', 'compare');
    await page.waitForFunction(() => window.__pidLab.comparison().enabled);
    let s = await state();
    assert.equal(s.active, 'B');
    assert.deepEqual(s.A.config, s.B.config);
    assert.equal(await page.locator('svg.chart-svg:visible').count(), 6);
    await assertSharedScales();
    checks.push('Comparison starts with two identical independent settings and six visible charts');

    await slide('Kp', 2);
    s = await state();
    assert.equal(s.A.config.Kp, 8);
    assert.equal(s.B.config.Kp, 2);
    assert.equal(s.resultA.config.Kp, 8);
    assert.equal(s.resultB.config.Kp, 2);
    assert.equal(await page.locator('#preset').inputValue(), 'custom');
    assert.equal(await page.locator('#preset option:checked').innerText(), '調整した設定');
    assert.match(await page.locator('#case-differences').innerText(), /Kp/);
    await page.locator('#edit-a').click();
    assert.equal(await page.locator('#Kp').inputValue(), '8');
    await slide('deadTime', 20);
    await select('form', 'incremental');
    s = await state();
    assert.equal(s.A.config.deadTime, 20);
    assert.equal(s.B.config.deadTime, 10);
    assert.equal(s.A.form, 'incremental');
    assert.equal(s.B.form, 'position');
    await page.locator('#edit-b').click();
    assert.equal(await page.locator('#Kp').inputValue(), '2');
    assert.equal(await page.locator('#deadTime').inputValue(), '10');
    assert.equal(await page.locator('#form').inputValue(), 'position');
    await assertSharedScales();
    const ta = await scales('terms'), tb = await scales('terms-b');
    assert.match(ta.unit, /寄与|出力|%/);
    assert.match(tb.unit, /寄与|出力|%/);
    assert.doesNotMatch(ta.unit + tb.unit, /変化 \[|ポイント/);
    checks.push('Controller, plant, and implementation form edits stay in their own case; term charts compare the same physical quantity');

    // Dispatch and switch within the same JS task, before the slider debounce can run.
    await page.evaluate(() => {
      const input = document.getElementById('Kp');
      input.value = '3';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('edit-a').click();
    });
    await page.waitForFunction(() => {
      const s = window.__pidLab.comparison();
      return s.active === 'A' && s.B.config.Kp === 3 && s.results.B.config.Kp === 3;
    });
    s = await state();
    assert.equal(s.A.config.Kp, 8);
    assert.equal(s.resultB.config.Kp, 3);
    checks.push('A rapid slider change followed by switching editor cannot edit the wrong case or leave a stale waveform');

    await select('horizon', '1200');
    await page.locator('#edit-b').click();
    await select('preset', 'basic');
    s = await state();
    assert.equal(s.A.config.horizon, 1200);
    assert.equal(s.B.config.horizon, 1200);
    assert.equal(s.resultA.config.horizon, 1200);
    assert.equal(s.resultB.config.horizon, 1200);
    assert.equal(s.A.form, 'incremental');
    assert.equal(s.A.config.Kp, 8);
    await assertSharedScales();
    checks.push('Changing a preset preserves the shared observation period and the untouched case');

    await page.locator('#copy-a-to-b').click();
    s = await state();
    assert.deepEqual(s.A.config, s.B.config);
    assert.equal(s.A.form, s.B.form);
    await page.locator('#edit-b').click();
    await slide('Kp', 4);
    s = await state();
    assert.equal(s.A.config.Kp, 8);
    assert.equal(s.B.config.Kp, 4);
    checks.push('Copy A to B copies both parameters and form without sharing mutable state');

    // Equal scales remain equal when only one pane hides a series.
    const beforeLegend = await scales('temperature');
    await page.locator('#temperature-legend button').first().click();
    await assertSharedScales();
    assert.deepEqual(await scales('temperature'), beforeLegend);
    await page.locator('#temperature-legend button').first().click();
    await page.locator('#time-cursor').fill('35');
    const live35 = await page.locator('#case-a-live').innerText();
    const liveB35 = await page.locator('#case-b-live').innerText();
    assert.ok(live35.length > 0 && liveB35.length > 0);
    await page.locator('#time-cursor').fill('85');
    assert.notEqual(await page.locator('#case-a-live').innerText(), live35);
    assert.notEqual(await page.locator('#case-b-live').innerText(), liveB35);
    const cursorXs = await page.locator('[data-cursor]').evaluateAll(lines => lines.map(e => Number(e.getAttribute('x1'))));
    assert.equal(cursorXs.length, 6);
    assert.ok(cursorXs.every(x => Math.abs(x - cursorXs[0]) < 0.01), JSON.stringify(cursorXs));
    checks.push('Both selected-time values and all six time cursors move together; hiding a series preserves shared axes');

    await page.locator('#temperature-b-chart').scrollIntoViewIfNeeded();
    const hit = await page.locator('#temperature-b-chart [data-chart-hit]').boundingBox();
    await page.mouse.move(hit.x + hit.width * .4, hit.y + hit.height * .5);
    assert.equal(await page.locator('#chart-tooltip').isVisible(), true);
    await page.locator('#temperature-b-chart [data-chart-hit]').click({ position: { x: hit.width * .25, y: hit.height * .5 } });
    assert.ok(parseFloat(await page.locator('#time-label').innerText()) > 0);
    checks.push('The right-hand plot supports tooltips and shared time selection');

    const beforeSingle = await state();
    await select('view-mode', 'single');
    assert.equal(await page.locator('svg.chart-svg:visible').count(), 3);
    assert.equal((await state()).enabled, false);
    assert.equal(await page.locator('#Kp').inputValue(), '4');
    await select('view-mode', 'compare');
    s = await state();
    assert.deepEqual(s.A.config, beforeSingle.A.config);
    assert.deepEqual(s.B.config, beforeSingle.B.config);
    checks.push('Single/comparison round trips retain both settings');

    await select('horizon', '600');
    await page.locator('#time-cursor').fill('35');
    await page.screenshot({ path: path.join(__dirname, 'compare-desktop.png'), fullPage: true });
    for (const width of [1560, 1280, 1024, 736, 360, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.waitForTimeout(200);
      const layout = await page.evaluate(() => {
        const visible = e => e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().height > 0;
        const chartA = document.querySelector('#temperature-chart svg').getBoundingClientRect();
        const chartB = document.querySelector('#temperature-b-chart svg').getBoundingClientRect();
        return { width: innerWidth, scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth,
          sideBySide: Math.abs(chartA.top - chartB.top) < 2 && chartB.left > chartA.left,
          clipped: [...document.querySelectorAll('svg text')].filter(visible).map(e => ({
            s: e.closest('svg').getBoundingClientRect(), r: e.getBoundingClientRect(), text: e.textContent
          })).filter(x => x.r.left < x.s.left - 1 || x.r.right > x.s.right + 1).map(x => x.text) };
      });
      assert.ok(layout.scroll <= layout.client + 1, JSON.stringify(layout));
      assert.deepEqual(layout.clipped, [], JSON.stringify(layout));
      if (width >= 736) assert.equal(layout.sideBySide, true, 'Expected side-by-side charts at ' + width);
      await assertSharedScales();
      layouts.push(layout);
    }
    await page.locator('#temperature-chart').screenshot({ path: path.join(__dirname, 'compare-mobile-a.png') });
    await page.locator('#temperature-b-chart').screenshot({ path: path.join(__dirname, 'compare-mobile-b.png') });
    checks.push('1560/1280/1024/736px show adjacent comparable panes; 360/320px fit without chart-label or page overflow');

    await page.setViewportSize({ width: 1560, height: 1120 });
    await select('horizon', '1800');
    await slide('Ts', .1);
    await page.locator('#edit-a').click();
    await slide('Ts', .1);
    const computeMs = await page.evaluate(() => window.__pidLab.computeMs);
    assert.ok(computeMs < 5000, 'Comparison recomputation took ' + computeMs + 'ms');
    assert.deepEqual(errors, []);
    checks.push('Two longest runs at fastest sampling stay responsive and emit no runtime errors');

    await page.reload();
    await page.waitForFunction(() => typeof window.__pidLab?.comparison === 'function');
    await page.locator('#save-reference').click();
    await slide('Kp', 3);
    await select('form', 'incremental');
    await select('horizon', '1200');
    await select('view-mode', 'compare');
    s = await state();
    assert.equal(s.A.config.Kp, 8);
    assert.equal(s.B.config.Kp, 3);
    assert.equal(s.A.form, 'position');
    assert.equal(s.B.form, 'incremental');
    assert.equal(s.resultA.config.horizon, 1200);
    assert.equal(s.resultB.config.horizon, 1200);
    await assertSharedScales();
    assert.deepEqual(errors, []);
    checks.push('First comparison uses a previously saved reference as A and the current setup as B, rerunning both over the shared horizon');

    await page.locator('#edit-a').click();
    assert.equal(await page.locator('#preset').inputValue(), 'custom');
    assert.equal(await page.locator('#preset option:checked').innerText(), '調整した設定');
    checks.push('A reference-derived case has an explicit custom-setting label rather than a blank or misleading preset');

    await page.reload();
    await page.waitForFunction(() => typeof window.__pidLab?.comparison === 'function');
    // Both clicks happen before any scheduled 40ms recomputation can execute.
    await page.evaluate(() => {
      const input = document.getElementById('Kp');
      input.value = '5';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('save-reference').click();
      const view = document.getElementById('view-mode');
      view.value = 'compare';
      view.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForFunction(() => window.__pidLab.comparison().enabled);
    s = await state();
    assert.equal(s.A.config.Kp, 5);
    assert.equal(s.B.config.Kp, 5);
    const immediate = await page.evaluate(() => {
      const c = window.__pidLab.comparison();
      return { refKp: window.__pidLab.reference().result.config.Kp,
        aP: c.results.A.records[0].P, bP: c.results.B.records[0].P,
        aOutput: c.results.A.records[0].u, bOutput: c.results.B.records[0].u };
    });
    assert.deepEqual(immediate, { refKp: 5, aP: 50, bP: 50, aOutput: 50.625, bOutput: 50.625 });
    await assertSharedScales();
    await page.locator('#edit-a').click();
    assert.equal(await page.locator('#preset').inputValue(), 'custom');
    assert.equal(await page.locator('#preset option:checked').innerText(), '調整した設定');
    assert.deepEqual(errors, []);
    checks.push('Saving immediately after slider input flushes the latest simulation before seeding both comparison plots');

    const report = { checks, layouts, computeMs, errors };
    fs.writeFileSync(path.join(__dirname, 'comparison-verification.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
