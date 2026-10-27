const { chromium } = require('playwright');
const { pathToFileURL } = require('node:url');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.PID_BROWSER_CHANNEL ? {channel:process.env.PID_BROWSER_CHANNEL} : {}) });
  const report = { checks: [], languages: [], layouts: [], issues: [], runtimeErrors: [] };
  const url = pathToFileURL(path.join(__dirname, 'pid-lab.html')).href;
  const issue = (check, lang, details) => report.issues.push({ check, lang, details });
  try {
    const context = await browser.newContext({ viewport: { width: 1560, height: 1120 }, deviceScaleFactor: 1 });
    // Intercept the public API before app.js initializes. The locale implementation
    // closes over its own text() for static bindings, so visible DOM is audited too.
    await context.addInitScript(() => {
      let wrapped;
      window.__localeAudit = { calls: [], missing: [] };
      Object.defineProperty(window, 'PIDLocale', {
        configurable: true,
        get: () => wrapped,
        set(api) {
          wrapped = Object.freeze({ ...api, text(ja, en, values) {
            const catalog = window.PIDTranslations.catalog;
            const key = Object.keys(catalog).find(k => catalog[k].en === en);
            if (!key) window.__localeAudit.missing.push(en);
            else window.__localeAudit.calls.push(key);
            return api.text(ja, en, values);
          } });
        }
      });
    });
    const page = await context.newPage();
    page.on('pageerror', error => report.runtimeErrors.push(error.message));
    await page.goto(url);
    await page.waitForFunction(() => window.__pidLab?.comparison && window.PIDLocale?.supportedLanguages);
    const langs = await page.evaluate(() => PIDLocale.supportedLanguages());
    assert.equal(langs.length, 10);
    assert.equal(await page.locator('html').getAttribute('lang'), 'en');
    assert.equal(await page.locator('#language-select option').count(), 10);
    const originalHints = await page.locator('#language-hints [lang]').evaluateAll(nodes => nodes.map(node => ({lang:node.lang,text:node.textContent.trim()})));
    assert.deepEqual(originalHints.map(hint=>hint.lang).sort(), [...langs].sort());
    assert.ok(originalHints.every(hint=>hint.text.length>0));
    const packAudit = await page.evaluate(() => {
      const {catalog, locales} = PIDTranslations;
      const placeholders = value => (value.match(/\{\d+\}/g) || []).sort().join('|');
      return Object.entries(locales).flatMap(([lang, pack]) => {
        const failures = Object.keys(pack).filter(key => !(key in catalog)).map(key => ({lang, key, error:'extra'}));
        for (const [key, message] of Object.entries(catalog)) {
          if (typeof pack[key] !== 'string' || !pack[key].trim()) failures.push({lang,key,error:'missing'});
          else if (placeholders(message.en) !== placeholders(pack[key])) failures.push({lang,key,error:'placeholders'});
        }
        return failures;
      });
    });
    assert.deepEqual(packAudit, []);
    report.checks.push('All 10 selector entries exist; 8 added packs cover all 181 messages with exact numbered placeholder multisets.');

    const snapshot = () => page.evaluate(() => {
      const app = __pidLab, comparison = app.comparison();
      const numerical = result => result && ({ config: result.config, form: result.form, stats: result.stats,
        records: result.records.map(r => [r.t,r.y,r.e,r.u,r.raw,r.P,r.I,r.D,r.prevI,r.prevRaw,r.prevU]),
        samples: result.samples.map(s => [s.t,s.y]) });
      return {config:app.config(), current:numerical(app.current()), A:comparison.A, B:comparison.B,
        results:Object.fromEntries(Object.entries(comparison.results || {}).map(([key,value])=>[key,numerical(value)])),
        active:comparison.active, enabled:comparison.enabled,
        reference:app.reference() && numerical(app.reference().result),
        cursor:document.getElementById('time-cursor').value,
        selections:['mode','form','preset','view-mode','horizon'].map(id=>[id,document.getElementById(id).value]),
        hiddenSeries:[...document.querySelectorAll('.chart-legend button[aria-pressed="false"]')].map(e=>[e.parentElement.id,e.dataset.series])};
    });
    async function slide(id, value) {
      const revision = await page.evaluate(() => __pidLab.revision());
      await page.locator('#' + id).fill(String(value));
      await page.waitForFunction(old => __pidLab.revision() > old, revision);
    }
    async function switchLanguage(lang) {
      const before = await snapshot();
      await page.locator('#language-select').selectOption(lang);
      await page.waitForFunction(code => document.documentElement.lang === code && PIDLocale.language() === code, lang);
      assert.deepEqual(await snapshot(), before, lang + ': language change altered simulation state');
      assert.equal(await page.locator('#language-select').inputValue(), lang);
    }
    async function auditRendered(lang) {
      const result = await page.evaluate(language => {
        const visible = element => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden';
        const forbidden = language === 'ja' ? null : /^zh-/.test(language) ? /[\u3040-\u30ff]/u : /[\u3040-\u30ff\u3400-\u9fff]/u;
        const found = [], unresolved = [];
        const test = (value, type, element) => {
          if (/\{\d+\}/.test(value)) unresolved.push({type,id:element.id,text:value});
          if (forbidden?.test(value)) found.push({type,id:element.id,text:value});
        };
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
          const element = node.parentElement;
          if (!element || element.closest('script,style,#language-select,#language-hints') || !visible(element)) continue;
          const range = document.createRange(); range.selectNodeContents(node);
          if (range.getClientRects().length) test(node.textContent, 'text', element);
        }
        for (const element of document.querySelectorAll('[aria-label],[title]')) {
          if (element.closest('#language-select,#language-hints') || !visible(element)) continue;
          for (const attribute of ['aria-label','title']) test(element.getAttribute(attribute) || '', attribute, element);
        }
        for (const select of document.querySelectorAll('select:not(#language-select)')) {
          if (visible(select)) for (const option of select.options) test(option.textContent, 'option', select);
        }
        return {found,unresolved};
      }, lang);
      if (result.found.length) issue('untranslated Japanese', lang, result.found);
      if (result.unresolved.length) issue('unresolved placeholders', lang, result.unresolved);
      const hints = await page.locator('#language-hints [lang]').evaluateAll(nodes => nodes.map(node => ({lang:node.lang,text:node.textContent.trim()})));
      assert.deepEqual(hints,originalHints,lang+': multilingual language-setting hints changed');
    }
    async function layout(lang, width) {
      await page.setViewportSize({width,height:1000});
      await page.waitForTimeout(180);
      const result = await page.evaluate(() => {
        const visible = element => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden';
        const pairs = ['temperature','output','terms'].map(id => {
          const a = document.querySelector('#'+id+'-chart svg').getBoundingClientRect();
          const b = document.querySelector('#'+id+'-b-chart svg').getBoundingClientRect();
          return {id, aligned:Math.abs(a.top-b.top)<2,sideBySide:b.left>a.left,aTop:a.top,bTop:b.top};
        });
        const clipped = [...document.querySelectorAll('svg text')].filter(visible).flatMap(element => {
          const svg=element.closest('svg').getBoundingClientRect(), rect=element.getBoundingClientRect();
          return rect.left < svg.left-1 || rect.right > svg.right+1 || rect.top < svg.top-1 || rect.bottom > svg.bottom+1
            ? [{text:element.textContent,chart:element.closest('.chart-container').id,left:rect.left-svg.left,right:rect.right-svg.right,top:rect.top-svg.top,bottom:rect.bottom-svg.bottom}] : [];
        });
        const selector = document.getElementById('language-select').getBoundingClientRect();
        const languageHints = [...document.querySelectorAll('#language-hints [lang]')].map(hint => {
          const range=document.createRange();range.selectNodeContents(hint);
          const rect=range.getBoundingClientRect(), container=document.getElementById('language-settings').getBoundingClientRect();
          return {lang:hint.lang,visible:visible(hint),text:hint.textContent.trim(),fits:rect.width>0&&rect.left>=Math.max(0,container.left)-1&&rect.right<=Math.min(innerWidth,container.right)+1&&rect.top>=container.top-1&&rect.bottom<=container.bottom+1};
        });
        const meterOverlaps = [...document.querySelectorAll('.device-meter')].filter(visible).flatMap(meter => {
          const label=meter.firstElementChild,track=meter.querySelector('.meter-track');
          const range=document.createRange();range.selectNodeContents(label);
          const labelRect=range.getBoundingClientRect(),trackRect=track.getBoundingClientRect();
          return labelRect.right>trackRect.left+0.5 ? [{text:label.textContent,labelRight:labelRect.right,trackLeft:trackRect.left}] : [];
        });
        return {width:innerWidth,scroll:document.documentElement.scrollWidth,client:document.documentElement.clientWidth,pairs,clipped,
          meterOverlaps,languageHints,selectorFits:selector.width>0&&selector.left>=0&&selector.right<=innerWidth+1};
      });
      report.layouts.push({lang,...result});
      if (result.scroll > result.client+1) issue('horizontal page overflow',lang,result);
      if (result.clipped.length) issue('SVG text clipping',lang,{width,clipped:result.clipped});
      if (result.meterOverlaps.length) issue('meter label overlap',lang,{width,overlaps:result.meterOverlaps});
      if (width>=736 && !result.pairs.every(pair=>pair.aligned&&pair.sideBySide)) issue('comparison alignment',lang,result);
      if (!result.selectorFits) issue('language selector overflow',lang,result);
      if (result.languageHints.length!==10||result.languageHints.some(hint=>!hint.visible||!hint.fits)) issue('language setting hints hidden or clipped',lang,{width,hints:result.languageHints});
    }

    await page.locator('#save-reference').click();
    await slide('Kp',3);
    await page.locator('#form').selectOption('incremental');
    await page.locator('#view-mode').selectOption('compare');
    await page.locator('#edit-a').click();
    await slide('deadTime',20);
    await page.locator('#edit-b').click();
    await page.locator('#time-cursor').fill('35');
    await page.locator('#temperature-legend button').first().click();
    await page.locator('.explanation-detail').evaluateAll(nodes=>nodes.forEach(node=>node.open=true));

    for (const lang of langs) {
      await switchLanguage(lang);
      await auditRendered(lang);
      await page.locator('#time-cursor').fill('0');
      assert.match(await page.locator('#calculation').innerText(), /#1(?:\D|$)/);
      await page.locator('#next-step').click();
      assert.match(await page.locator('#calculation').innerText(), /#2(?:\D|$)/);
      const step = await page.evaluate(() => ({cursor:Number(document.getElementById('time-cursor').value), second:__pidLab.current().records[1]}));
      assert.equal(step.cursor,step.second.t);
      assert.ok((await page.locator('#calculation').innerText()).includes('I ='));
      for (const mode of ['P','PI','PID']) {
        await page.locator('#mode').selectOption(mode);
        for (const form of ['position','incremental']) {
          await page.locator('#form').selectOption(form);
          await auditRendered(lang);
        }
      }
      await page.locator('#view-mode').selectOption('single');
      await page.locator('#compareForms').check();
      await auditRendered(lang);
      assert.equal(await page.locator('#reference-label').isVisible(),true);
      await page.locator('#view-mode').selectOption('compare');
      await page.locator('#time-cursor').fill('35');
      for (const width of [1560,1024,736,360,320]) await layout(lang,width);
      if (lang==='de') {
        await page.locator('#temperature-legend button').first().click();
        await page.setViewportSize({width:1560,height:1120});
        await page.waitForTimeout(180);
        await page.screenshot({path:path.join(__dirname,'multilingual-de-desktop.png'),fullPage:true});
        await page.locator('#temperature-legend button').first().click();
      }
      if (lang==='ko') {
        await page.locator('#temperature-legend button').first().click();
        await page.evaluate(()=>window.scrollTo(0,0));
        await page.screenshot({path:path.join(__dirname,'multilingual-ko-mobile-top.png')});
        await page.evaluate(()=>window.scrollTo(0,document.getElementById('temperature-chart').getBoundingClientRect().top+scrollY-115));
        await page.screenshot({path:path.join(__dirname,'multilingual-ko-mobile.png')});
        await page.locator('#temperature-legend button').first().click();
      }
      report.languages.push({lang, statePreserved:true, firstAndSecondSteps:true, modes:['P','PI','PID'],forms:['position','incremental']});
    }
    report.checks.push('Every language switch preserves A/B configs, computed records/samples/statistics, references, cursor, selections and hidden chart series.');
    report.checks.push('First and second control calculations, P/PI/PID modes, both calculation forms, reference overlays and A/B views audited in every language.');
    report.checks.push('All 10 languages checked at 320/360/736/1024/1560 px for page overflow, SVG text clipping, meter label overlap, selector accessibility and paired-chart alignment.');
    report.checks.push('All 10 permanent language-setting hints stay unchanged, visible and unclipped across every active language and viewport size.');

    // Exercise feedback that is only rendered when a target is unreachable.
    await page.locator('#view-mode').selectOption('single');
    await page.locator('#preset').selectOption('saturation');
    await slide('target',60);
    for (const lang of langs) { await switchLanguage(lang); await auditRendered(lang); }
    const audit = await page.evaluate(() => ({missing:[...new Set(__localeAudit.missing)],dynamicKeys:[...new Set(__localeAudit.calls)].sort()}));
    report.dynamicKeys=audit.dynamicKeys;
    if(audit.missing.length) issue('dynamic message absent from catalog','all',audit.missing);

    // Persistence is checked independently from state preservation: reloading is
    // expected to reset the simulation, while retaining the selected language.
    for(const lang of langs){
      await page.locator('#language-select').selectOption(lang);
      assert.equal(await page.evaluate(()=>localStorage.getItem('pid-lab-language')),lang);
      await page.reload();
      await page.waitForFunction(code=>window.__pidLab&&document.documentElement.lang===code&&PIDLocale.language()===code,lang);
      assert.equal(await page.locator('#language-select').inputValue(),lang);
      await auditRendered(lang);
    }
    report.checks.push('All 10 saved language choices survive reload; unreachable-target and saturation feedback also translate.');
    if(report.runtimeErrors.length)issue('runtime exceptions','all',report.runtimeErrors);
    report.passed=report.issues.length===0;
  } catch(error) {
    report.passed=false;
    report.issues.push({check:'test aborted',details:error.stack});
  } finally {
    fs.writeFileSync(path.join(__dirname,'multilingual-verification.json'),JSON.stringify(report,null,2));
    console.log(JSON.stringify({passed:report.passed,checks:report.checks,languages:report.languages.length,layouts:report.layouts.length,issues:report.issues,runtimeErrors:report.runtimeErrors},null,2));
    await browser.close();
  }
  if(!report.passed)process.exitCode=1;
})().catch(error=>{console.error(error);process.exitCode=1;});
