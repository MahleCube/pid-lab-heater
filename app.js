(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const tr = (ja, en, values) => PIDLocale.text(ja, en, values);
  const formName = form => form==='position'?tr('位置形','Positional'):tr('増分形','Incremental');
  const unreachableNote = () => tr(' ／ この機器では目標を維持できません',' / This plant cannot maintain the target');
  const settlingLabel = stats => stats.settleTime===null?tr('観測期間内では未達','not reached during this run'):tr(`${fmt(stats.settleTime,1)}s 以降`,"from {0}s to the end", [fmt(stats.settleTime,1)]);
  const NS = 'http://www.w3.org/2000/svg';
  const fields = [
    ['target','目標温度',10,60,1,'°C','到達・維持したい温度。','controller'],
    ['Kp','比例ゲイン Kp',0,20,.1,'%/°C','誤差 1°C あたりの比例出力。','controller'],
    ['Ti','積分時間 Ti',5,600,5,'s','短くするほど積分が強くなる。','controller'],
    ['Td','微分時間 Td',0,60,.5,'s','大きくするほど温度変化への補正が強くなる。','controller'],
    ['Ts','制御周期',.1,10,.1,'s','測定と出力更新の間隔。PWM の周期とは別。','controller'],
    ['gain','機器のゲイン G',.1,1,.05,'°C/%','一定出力を 1 ポイント増やしたときの定常温度上昇。','plant'],
    ['tau','時定数 τ',5,180,5,'s','温度変化が始まってから、最終変化の約 63% に達する時間。','plant'],
    ['deadTime','むだ時間 L',0,60,.5,'s','指令を出してから加熱に届くまでの遅れ。','plant'],
    ['ambient','周囲温度',0,40,1,'°C','放熱先の温度。','plant'],
    ['initial','初期温度',0,60,1,'°C','毎回の計算を開始する温度。','plant'],
    ['maxOutput','出力の上限',10,100,5,'%','100% を定格最大出力とした上限。','plant']
  ];
  const englishFields = {
    target:['Target temperature','The temperature to reach and maintain.'],
    Kp:['Proportional gain Kp','Proportional output per 1°C of error.'],
    Ti:['Integral time Ti','A shorter time makes integral action stronger.'],
    Td:['Derivative time Td','A longer time gives stronger correction for temperature changes.'],
    Ts:['Control period','Time between measurements and output updates; separate from the PWM period.'],
    gain:['Plant gain G','Steady temperature rise for a 1 percentage-point increase in constant output.'],
    tau:['Time constant τ','Time from the start of the temperature response to about 63% of its final change.'],
    deadTime:['Dead time L','Delay between issuing a command and its effect on heating.'],
    ambient:['Ambient temperature','Temperature of the surroundings receiving the lost heat.'],
    initial:['Initial temperature','Starting temperature used for each simulation.'],
    maxOutput:['Output limit','Upper limit, with 100% representing rated full output.']
  };
  let config = Object.assign({}, PIDLab.DEFAULTS);
  let pair, current, reference = null, cursor = 0, timer = null, revision = 0;
  let charts = [], pending = 0;
  let comparisonEnabled = false, activeCase = 'B', scenarios = null;
  let scenarioResults = null;
  const hidden = new Set();
  const customPreset=document.createElement('option');
  customPreset.value='custom';customPreset.textContent=tr('調整した設定','Custom settings');customPreset.disabled=true;$('preset').appendChild(customPreset);
  const presets = {
    basic: {Kp:2,Ti:60,Td:2.5,mode:'PI'},
    proportional: {Kp:2,Ti:60,Td:2.5,mode:'P'},
    fast: {Kp:8,Ti:80,Td:2.5,mode:'PID'},
    oscillate: {Kp:2,Ti:20,Td:2.5,mode:'PI'},
    saturation: {Kp:8,Ti:20,Td:2.5,mode:'PI',target:50,maxOutput:65}
  };
  function fmt(v, digits=2) { return Number.isFinite(v) ? (Math.abs(v)<.5*Math.pow(10,-digits)?0:v).toFixed(digits) : '—'; }
  function compact(v) { return Number(v.toPrecision(5)).toString(); }
  function node(tag, attrs={}, parent) {
    const e=document.createElementNS(NS,tag);
    Object.entries(attrs).forEach(([k,v])=>e.setAttribute(k,String(v)));
    if(parent) parent.appendChild(e); return e;
  }
  function text(parent, x,y,value,attrs={}) {
    const e=node('text',Object.assign({x,y,fill:'var(--foreground)','font-size':12},attrs),parent);e.textContent=value;return e;
  }
  function floorIndex(data,t) {
    let lo=0,hi=data.length-1;
    while(lo<hi){const m=Math.ceil((lo+hi)/2);if(data[m].t<=t+1e-8)lo=m;else hi=m-1;}return lo;
  }
  function valueAt(s,t) {
    if(!s.data.length || t < s.data[0].t-1e-8 || t>s.data[s.data.length-1].t+1e-8)return null;
    const i=floorIndex(s.data,t), a=s.data[i], b=s.data[Math.min(i+1,s.data.length-1)];
    if(s.step||a===b||b.t===a.t)return a.v;
    return a.v+(b.v-a.v)*(t-a.t)/(b.t-a.t);
  }
  function series(id,label,data,key,color,step=false,dash='') {
    return {id,label,data:data.map(r=>({t:r.t,v:r[key]})),color,step,dash};
  }
  function heldSeries(result,key) {
    const data=result.records.map(r=>({t:r.t,v:r[key]}));
    if(data[data.length-1].t<result.config.horizon)data.push({t:result.config.horizon,v:data[data.length-1].v});
    return data;
  }
  function delayedSeries(result) {
    const data=[{t:0,v:0}];
    result.records.forEach(r=>{const t=r.t+result.config.deadTime;if(t<=result.config.horizon)data.push({t,v:r.u});});
    data.push({t:result.config.horizon,v:data[data.length-1].v});return data;
  }
  fields.forEach(([key,label,min,max,step,unit,hint,group])=>{
    const div=document.createElement('div'); div.className='control-field';
    const header=document.createElement('div');header.className='control-heading';
    const l=document.createElement('label');l.htmlFor=key;l.textContent=tr(label,englishFields[key][0]);
    const value=document.createElement('output');value.id=key+'-value';value.htmlFor=key;value.className='control-value';
    header.append(l,value);
    const range=document.createElement('input');Object.assign(range,{id:key,type:'range',min,max,step,value:config[key]});
    const help=document.createElement('div');help.className='control-hint';help.id=key+'-hint';help.textContent=tr(hint,englishFields[key][1]);
    range.setAttribute('aria-describedby',help.id);
    div.append(header,range,help);$(group+'-fields').appendChild(div);
    range.addEventListener('input',()=>{config[key]=Number(range.value);$('preset').value='custom';updateLabels();schedule();});
  });
  function updateLabels() {
    fields.forEach(([key,label,min,max,step,unit,hint])=>{
      document.querySelector('label[for="'+key+'"]').textContent=tr(label,englishFields[key][0]);
      $(key+'-hint').textContent=tr(hint,englishFields[key][1]);
      $(key).value=config[key];$(key+'-value').textContent=compact(config[key])+' '+unit;
      $(key).disabled=(key==='Ti'&&config.mode==='P')||(key==='Td'&&config.mode!=='PID');
    });
    $('mode').value=config.mode;$('antiWindup').checked=config.antiWindup;
    $('horizon').value=config.horizon;
    customPreset.textContent=tr('調整した設定','Custom settings');
    $('play').textContent=timer===null?tr('再生','Play'):tr('一時停止','Pause');
    const g=PIDLab.gains(config);
    $('derived-gains').textContent=(config.mode==='P'?tr('Ki = 0（I 無効）','Ki = 0 (I disabled)'):`Ki = Kp / Ti = ${compact(g.Ki)} %/(°C·s)`)+'　|　'+(config.mode!=='PID'?tr('Kd = 0（D 無効）','Kd = 0 (D disabled)'):`Kd = Kp × Td = ${compact(g.Kd)} %·s/°C`);
    $('form-description').textContent=$('form').value==='position'
      ? tr('位置形：基準出力 0% に P・I・D を足し、出力の指令値を計算します。','Positional form: add P, I and D to the 0% base output to calculate the command.')
      : tr('増分形：前回の計算値に ΔP・ΔI・ΔD を足します。「現在温度」からの増分ではありません。出力制限中は、計算値と実際の出力を分けて保持します。','Incremental form: add ΔP, ΔI and ΔD to the previous calculated command, not to the current temperature. During output limiting, retain the calculated command separately from the actual output.');
    $('model-description').textContent=tr(`100% を続けたときの定常温度：${fmt(config.ambient+100*config.gain,1)}°C。現在の出力上限 ${config.maxOutput}% なら ${fmt(config.ambient+config.maxOutput*config.gain,1)}°C。`,"Steady temperature at constant 100% output: {0}°C. At the current {1}% limit: {2}°C.", [fmt(config.ambient+100*config.gain,1), config.maxOutput, fmt(config.ambient+config.maxOutput*config.gain,1)]);
    updateReferenceLabel();
  }
  function updateReferenceLabel(){
    if(!reference){$('reference-label').textContent='';return;}
    const c=reference.result.config;
    $('reference-label').textContent=tr(`参考：${c.mode} / Kp ${c.Kp} / Ti ${c.Ti}s / Td ${c.Td}s / 周期 ${c.Ts}s / G ${c.gain} / τ ${c.tau}s / L ${c.deadTime}s`,"Reference: {0} / Kp {1} / Ti {2}s / Td {3}s / period {4}s / G {5} / τ {6}s / L {7}s", [c.mode, c.Kp, c.Ti, c.Td, c.Ts, c.gain, c.tau, c.deadTime]);
  }
  function schedule(){stop();clearTimeout(pending);pending=setTimeout(recompute,40);}
  function rememberCase(){
    if(scenarios)scenarios[activeCase]={config:{...config},form:$('form').value,preset:$('preset').value};
  }
  function loadCase(key){
    stop();clearTimeout(pending);rememberCase();activeCase=key;
    const s=scenarios[key];config={...s.config};$('form').value=s.form;$('preset').value=s.preset;
    recompute();
  }
  function setComparison(enabled){
    stop();clearTimeout(pending);rememberCase();
    if(enabled&&!scenarios){
      const seed={config:{...config},form:$('form').value,preset:$('preset').value};
      scenarios={A:reference?{config:{...reference.result.config,horizon:config.horizon},form:reference.form,preset:'custom'}:{...seed,config:{...config}},B:seed};
      activeCase='B';
    }
    comparisonEnabled=enabled;
    document.body.classList.toggle('comparison-mode',enabled);
    document.querySelectorAll('.compare-only').forEach(e=>e.hidden=!enabled);
    ['comparison-editor','comparison-chart-note','editing-label'].forEach(id=>$(id).hidden=!enabled);
    document.querySelector('.comparison-controls').hidden=enabled;
    $('reference-label').hidden=enabled;
    $('comparison-status').hidden=enabled;
    recompute();
  }
  function updateComparisonLabels(){
    $('editing-label').textContent=tr(`編集中：${activeCase}`,"Editing: {0}", [activeCase]);
    $('edit-a').setAttribute('aria-pressed',activeCase==='A');$('edit-b').setAttribute('aria-pressed',activeCase==='B');
    $('state-heading').textContent=comparisonEnabled?tr(`${activeCase} の現在の状態`,"{0}: Current state", [activeCase]):tr('現在の状態','Current state');
    if(!comparisonEnabled)return;
    const descriptors=[['mode',tr('制御','Control'),''],['form',tr('方式','Form'),''],...fields.map(f=>[f[0],tr(f[1],englishFields[f[0]][0]),f[5]]),['antiWindup',tr('積分制限','Anti-windup'),'']];
    const val=(s,k)=>k==='form'?(s.form==='position'?tr('位置形','Positional'):tr('増分形','Incremental')):k==='antiWindup'?(s.config[k]?tr('有効','Enabled'):tr('無効','Disabled')):s.config[k];
    const diffs=descriptors.filter(([k])=>val(scenarios.A,k)!==val(scenarios.B,k)).map(([k,label,unit])=>`${label}：A ${val(scenarios.A,k)}${unit} ／ B ${val(scenarios.B,k)}${unit}`);
    $('case-differences').textContent=diffs.length?tr('設定の違い　','Different settings: ')+diffs.join(' ｜ '):tr('A と B は同じ設定です。B のゲインなどを動かすと、違いが見えます。','A and B have identical settings. Change a gain or another setting in B to see the difference.');
    ['A','B'].forEach(key=>{
      const s=scenarios[key], c=s.config,r=scenarioResults[key];
      $(key==='A'?'case-a-summary':'case-b-summary').textContent=tr(
        `${key}：${c.mode}・${s.form==='position'?'位置形':'増分形'} ｜ Kp ${c.Kp} / Ti ${c.Ti}s / Td ${c.Td}s / 周期 ${c.Ts}s\n最終 ${fmt(r.stats.finalTemperature)}°C ／ 最高 ${fmt(r.stats.peakTemperature)}°C\n出力制限：${fmt(r.stats.saturationTime,1)}s${r.stats.reachable?'':' ／ この機器では目標を維持できません'}`,"{0}: {1} · {2} | Kp {3} / Ti {4}s / Td {5}s / period {6}s\nFinal {7}°C / Peak {8}°C\nOutput limited: {9}s{10}", [key, c.mode, formName(s.form), c.Kp, c.Ti, c.Td, c.Ts, fmt(r.stats.finalTemperature), fmt(r.stats.peakTemperature), fmt(r.stats.saturationTime,1), r.stats.reachable?'':unreachableNote()]);
    });
  }
  function recompute() {
    clearTimeout(pending);
    const started=performance.now();
    try {
      config=PIDLab.normalize(config);rememberCase();
      if(comparisonEnabled){
        ['A','B'].forEach(k=>scenarios[k].config.horizon=config.horizon);
        const pairs={A:PIDLab.compare(scenarios.A.config),B:PIDLab.compare(scenarios.B.config)};
        scenarioResults={A:pairs.A[scenarios.A.form],B:pairs.B[scenarios.B.form]};
        pair=pairs[activeCase];
      }else pair=PIDLab.compare(config);
      current=$('form').value==='position'?pair.position:pair.incremental;
      revision++;$('app-error').hidden=true;
      $('time-cursor').max=config.horizon;cursor=Math.min(cursor,config.horizon);
      const stats=current.stats;
      $('status-summary').textContent=tr(
        `${comparisonEnabled?activeCase+'：':''}${config.horizon}s 後 ${fmt(stats.finalTemperature)}°C ／ 最大上振れ ${fmt(stats.overshoot)}°C ／ ±0.1°C 内を維持：${stats.settleTime===null?'観測期間内では未達':fmt(stats.settleTime,1)+'s 以降'}`,"{0}At {1}s: {2}°C / Maximum excess above target: {3}°C / Remains within ±0.1°C: {4}", [comparisonEnabled?activeCase+': ':'', config.horizon, fmt(stats.finalTemperature), fmt(stats.overshoot), settlingLabel(stats)]);
      let message=$('compareForms').checked?tr(`両方式の温度差の最大値 ${pair.maxTemperatureDifference.toExponential(1)}°C。同じ条件では線が重なります。`,"Maximum temperature difference between forms: {0}°C. Under identical conditions, the lines overlap.", [pair.maxTemperatureDifference.toExponential(1)]):tr('同じ初期状態・係数・出力制限処理なら、位置形と増分形は同じ応答になります。','With identical initial states, coefficients and output-limit handling, positional and incremental forms give the same response.');
      if(!stats.reachable)message+=tr(` この機器では目標 ${config.target}°C を維持できません。`," This plant cannot maintain the {0}°C target.", [config.target]);
      if(stats.saturationTime>0)message+=tr(` 出力制限に達した時間：${fmt(stats.saturationTime,1)}s。`," Time at output limits: {0}s.", [fmt(stats.saturationTime,1)]);
      $('comparison-status').textContent=message;
      updateLabels();updateComparisonLabels();drawAll();setCursor(cursor);
      window.__pidLab={config:()=>({...config}),current:()=>current,pair:()=>pair,reference:()=>reference,revision:()=>revision,language:()=>PIDLocale.language(),computeMs:performance.now()-started,
        comparison:()=>({enabled:comparisonEnabled,active:activeCase,A:scenarios?.A,B:scenarios?.B,results:scenarioResults})};
    }catch(e){$('app-error').hidden=false;$('app-error').textContent=tr('計算できませんでした：','Could not calculate: ')+e.message;console.error(e);}
  }
  function drawAll() {
    if(!current)return;charts=[];
    if(comparisonEnabled){drawComparison();return;}
    const c1='var(--series-1)', c2='var(--series-2)', c3='var(--series-3)',c4='var(--series-4)',neutral='var(--foreground)';
    const temp=[series('temperature',tr('温度','Temperature'),current.samples,'y',c1),{id:'target-line',label:tr('目標','Target'),data:[{t:0,v:config.target},{t:config.horizon,v:config.target}],color:neutral,dash:'6 5'}];
    const out=[{id:'output',label:tr('ヒーター指令','Heater command'),data:heldSeries(current,'u'),color:c2,step:true},{id:'delayed',label:tr('遅れて届いた出力','Delayed output'),data:delayedSeries(current),color:c3,step:true,dash:'5 4'}];
    if($('compareForms').checked){const other=$('form').value==='position'?pair.incremental:pair.position;
      const label=$('form').value==='position'?tr('増分形で計算','Incremental form'):tr('位置形で計算','Positional form');
      temp.push(series('other-temperature',label,other.samples,'y',c4,false,'2 5'));
      out.push({id:'other-output',label,data:heldSeries(other,'u'),color:c4,step:true,dash:'2 5'});
    }
    if(reference){
      temp.push(series('ref-temperature',tr('保存した温度','Saved temperature'),reference.result.samples,'y','var(--muted)',false,'8 5'));
      temp.push({id:'ref-target',label:tr('保存した目標','Saved target'),data:[{t:0,v:reference.result.config.target},{t:reference.result.config.horizon,v:reference.result.config.target}],color:'var(--muted)',dash:'2 4'});
      out.push({id:'ref-output',label:tr('保存した指令','Saved command'),data:heldSeries(reference.result,'u'),color:'var(--muted)',step:true,dash:'8 5'});
    }
    const incremental=$('form').value==='incremental';
    const termKeys=incremental?['dp','di','dd']:['P','I','D'];
    const terms=termKeys.map((key,i)=>({id:key,label:incremental?'Δ'+['P','I','D'][i]:key,data:heldSeries(current,key),color:[c1,c2,c3][i],step:true}));
    $('terms-title').textContent=incremental?tr('今回の増減量 ΔP・ΔI・ΔD','This update: ΔP, ΔI and ΔD'):tr('出力を構成する P・I・D','P, I and D output contributions');
    makeChart('temperature',temp,tr('温度 [°C]','Temperature [°C]'),[config.initial,config.target]);
    makeChart('output',out,tr('出力 [%]','Output [%]'),[0,config.maxOutput]);
    makeChart('terms',terms,incremental?tr('変化 [ポイント]','Change [percentage points]'):tr('寄与 [%]','Contribution [%]'),[0]);
    drawCursors();
  }
  function comparisonSeries(key){
    const r=scenarioResults[key],c=r.config,p=key.toLowerCase();
    return {
      temperature:[series(p+'-temperature',tr('温度','Temperature'),r.samples,'y','var(--series-1)'),{id:p+'-target',label:tr('目標','Target'),data:[{t:0,v:c.target},{t:c.horizon,v:c.target}],color:'var(--foreground)',dash:'6 5'}],
      output:[{id:p+'-output',label:tr('ヒーター指令','Heater command'),data:heldSeries(r,'u'),color:'var(--series-2)',step:true},{id:p+'-delayed',label:tr('遅れて届いた出力','Delayed output'),data:delayedSeries(r),color:'var(--series-3)',step:true,dash:'5 4'}],
      terms:['P','I','D'].map((v,i)=>({id:p+'-'+v,label:v,data:heldSeries(r,v),color:`var(--series-${i+1})`,step:true}))
    };
  }
  function sharedDomain(seriesList,extra,kind){
    let lo=Math.min(...extra),hi=Math.max(...extra);
    seriesList.forEach(s=>s.data.forEach(p=>{if(p.t<=config.horizon){lo=Math.min(lo,p.v);hi=Math.max(hi,p.v);}}));
    const pad=Math.max((hi-lo)*.09,kind==='temperature'?.25:.1);return [lo-pad,hi+pad];
  }
  function drawComparison(){
    const data={A:comparisonSeries('A'),B:comparisonSeries('B')};
    const extras={temperature:[scenarios.A.config.initial,scenarios.B.config.initial],output:[0,scenarios.A.config.maxOutput,scenarios.B.config.maxOutput],terms:[0]};
    const labels={temperature:tr('温度 [°C]','Temperature [°C]'),output:tr('出力 [%]','Output [%]'),terms:tr('寄与 [%]','Contribution [%]')};
    $('terms-title').textContent=tr('出力を構成する P・I・D','P, I and D output contributions');$('terms-b-title').textContent=tr('出力を構成する P・I・D','P, I and D output contributions');
    // Matching physical quantities and a shared scale keep different controller
    // forms and sampling intervals comparable. Increment details stay below.
    ['temperature','output','terms'].forEach(kind=>{
      const domain=sharedDomain([...data.A[kind],...data.B[kind]],extras[kind],kind);
      makeChart(kind,data.A[kind],labels[kind],extras[kind],{domain,kind,unit:kind==='temperature'?'°C':'%',caseLabel:'A'});
      makeChart(kind+'-b',data.B[kind],labels[kind],extras[kind],{domain,kind,unit:kind==='temperature'?'°C':'%',caseLabel:'B'});
    });
    const summaries=[...document.querySelectorAll('.case-summary-wrapper')];
    summaries.forEach(e=>e.style.minHeight='');
    if(window.innerWidth>700){const h=Math.max(...summaries.map(e=>e.getBoundingClientRect().height));summaries.forEach(e=>e.style.minHeight=h+'px');}
    drawCursors();
  }
  function makeChart(id, allSeries, ylabel, extra, options={}) {
    const container=$(id+'-chart');container.replaceChildren();
    const kind=options.kind||id,unit=options.unit||(id==='temperature'?'°C':id==='terms'&&$('form').value==='incremental'?'pt':'%');
    const width=Math.max(260,container.getBoundingClientRect().width),height=235;
    const m={left:63,right:15,top:26,bottom:44}, x0=m.left,x1=width-m.right,y0=m.top,y1=height-m.bottom;
    const active=allSeries.filter(s=>!hidden.has(s.id));
    let low=Math.min(...extra),high=Math.max(...extra);
    active.forEach(s=>s.data.forEach(p=>{if(p.t<=config.horizon){low=Math.min(low,p.v);high=Math.max(high,p.v);}}));
    const pad=Math.max((high-low)*.09, id==='temperature'?.25:.1);low-=pad;high+=pad;
    if(options.domain)[low,high]=options.domain;
    const xs=t=>x0+t/config.horizon*(x1-x0),ys=v=>y1-(v-low)/(high-low)*(y1-y0);
    const svg=node('svg',{viewBox:`0 0 ${width} ${height}`,width:'100%',height,role:'img','aria-label':(options.caseLabel?options.caseLabel+' ':'')+ylabel+tr(' の時間変化',' over time'),class:'chart-svg','data-y-min':low,'data-y-max':high,'data-x-max':config.horizon},container);
    const clip=node('clipPath',{id:'clip-'+id},node('defs',{},svg));node('rect',{x:x0,y:y0,width:x1-x0,height:y1-y0},clip);
    text(svg,x0,15,ylabel,{'font-size':12});
    const nx=width<380?3:4;
    for(let i=0;i<=nx;i++){const t=config.horizon*i/nx,x=xs(t);node('line',{x1:x,x2:x,y1:y0,y2:y1,stroke:'var(--border)','stroke-width':.7},svg);text(svg,x,y1+20,fmt(t,0),{'text-anchor':i===0?'start':i===nx?'end':'middle'});}
    for(let i=0;i<5;i++){const v=low+(high-low)*i/4,y=ys(v);node('line',{x1:x0,x2:x1,y1:y,y2:y,stroke:'var(--border)','stroke-width':.7},svg);text(svg,x0-9,y+4,fmt(v,high-low<4?1:0),{'text-anchor':'end'});}
    text(svg,(x0+x1)/2,height-5,tr('経過時間 [s]','Elapsed time [s]'),{'text-anchor':'middle'});
    node('rect',{x:x0,y:y0,width:x1-x0,height:y1-y0,fill:'none',stroke:'var(--border)'},svg);
    const paths=node('g',{'clip-path':`url(#clip-${id})`},svg);
    active.forEach(s=>{
      let d='';s.data.forEach((p,i)=>{const x=xs(p.t).toFixed(2),y=ys(p.v).toFixed(2);d+=i?(s.step?`H${x}V${y}`:`L${x},${y}`):`M${x},${y}`;});
      node('path',{d,fill:'none',stroke:s.color,'stroke-width':s.id.startsWith('other')?2:2.1,'stroke-dasharray':s.dash||'','data-series':s.id},paths);
    });
    const cursorLine=node('line',{y1:y0,y2:y1,stroke:'var(--foreground)','stroke-width':1,'stroke-dasharray':'3 4',opacity:.6,'data-cursor':id},svg);
    const hoverLine=node('line',{y1:y0,y2:y1,stroke:'var(--foreground)','stroke-width':1,visibility:'hidden'},svg);
    const markers=active.map(s=>node('circle',{r:3.5,fill:s.color,stroke:'var(--background)','stroke-width':1.5,visibility:'hidden'},svg));
    const hit=node('rect',{x:x0,y:y0,width:x1-x0,height:y1-y0,fill:'transparent','data-chart-hit':id},svg);
    hit.style.touchAction='pan-y';
    function hover(event,pin=false){
      const bounds=svg.getBoundingClientRect();const x=Math.max(x0,Math.min(x1,(event.clientX-bounds.left)*width/bounds.width));
      const t=(x-x0)/(x1-x0)*config.horizon;
      hoverLine.setAttribute('x1',x);hoverLine.setAttribute('x2',x);hoverLine.setAttribute('visibility','visible');
      const tooltip=$('chart-tooltip');tooltip.replaceChildren();
      const heading=document.createElement('strong');heading.textContent=(options.caseLabel?options.caseLabel+'　':'')+fmt(t,1)+' s';tooltip.appendChild(heading);
      active.forEach((s,i)=>{const v=valueAt(s,t);markers[i].setAttribute('visibility',v===null?'hidden':'visible');if(v===null)return;
        markers[i].setAttribute('cx',x);markers[i].setAttribute('cy',ys(v));
        const line=document.createElement('div');line.textContent=s.label+'　'+fmt(v)+' '+unit;tooltip.appendChild(line);
      });
      tooltip.hidden=false;const tb=tooltip.getBoundingClientRect();
      tooltip.style.left=Math.max(8,Math.min(window.innerWidth-tb.width-8,event.clientX+14))+'px';
      tooltip.style.top=Math.max(8,Math.min(window.innerHeight-tb.height-8,event.clientY+14))+'px';
      if(pin){stop();setCursor(t);}
    }
    hit.addEventListener('pointermove',e=>hover(e,false));hit.addEventListener('pointerdown',e=>hover(e,true));
    hit.addEventListener('pointerleave',()=>{hoverLine.setAttribute('visibility','hidden');markers.forEach(e=>e.setAttribute('visibility','hidden'));$('chart-tooltip').hidden=true;});
    charts.push({cursorLine,xs,x0,x1});
    const legend=$(id+'-legend');legend.replaceChildren();
    allSeries.forEach(s=>{const b=document.createElement('button');b.type='button';b.className='legend-item';b.setAttribute('aria-pressed',!hidden.has(s.id));
      const swatch=document.createElement('span');swatch.className='legend-swatch';swatch.style.borderColor=s.color;swatch.style.borderTopStyle=s.dash?'dashed':'solid';
      b.append(swatch,document.createTextNode(s.label));b.addEventListener('click',()=>{hidden.has(s.id)?hidden.delete(s.id):hidden.add(s.id);drawAll();});legend.appendChild(b);
    });
  }
  function drawCursors(){charts.forEach(c=>{c.cursorLine.setAttribute('x1',c.xs(cursor));c.cursorLine.setAttribute('x2',c.xs(cursor));});}
  function stateAt(result,t){
    const c=result.config,i=floorIndex(result.records,t),r=result.records[i];
    // Reconstruct the selected instant with exact held-input propagation from
    // the preceding chart sample, splitting at every intervening arrival.
    const j=floorIndex(result.samples,t),sample=result.samples[j];
    let y=sample.y,at=sample.t,applied=sample.appliedDelayed;
    let k=Math.max(0,Math.floor((at-c.deadTime)/c.Ts)+1);
    for(;k<result.records.length;k++){
      const arrival=result.records[k].t+c.deadTime;if(arrival>t+1e-8)break;if(arrival<=at+1e-8)continue;
      y=PIDLab.advancePlant(y,applied,arrival-at,c);at=arrival;applied=result.records[k].u;
    }
    y=PIDLab.advancePlant(y,applied,Math.max(0,t-at),c);return {i,r,y,applied};
  }
  function setCursor(t){
    cursor=Math.max(0,Math.min(config.horizon,t));$('time-cursor').value=cursor;$('time-label').textContent=fmt(cursor,1)+' s';
    const {i,r,y,applied}=stateAt(current,cursor);
    $('temperature-value').textContent=fmt(y)+' °C';$('error-value').textContent=fmt(config.target-y)+' °C';
    $('output-value').textContent=fmt(r.u)+' %';$('delayed-value').textContent=fmt(applied)+' %';
    $('temperature-fill').style.width=Math.max(0,Math.min(100,y/(Math.max(config.target,config.ambient+config.gain*config.maxOutput,config.initial,1))*100))+'%';
    $('heat-fill').style.width=r.u+'%';$('device-target').textContent=tr('目標 ','Target ')+config.target+'°C';
    $('time-detail').textContent=tr(`制御計算 #${i+1}：${fmt(r.t,1)}s の測定温度 ${fmt(r.y,3)}°C で計算。次の更新まで指令を保持。`,"Control update #{0}: calculated from the {1}°C measurement at {2}s. The command is held until the next update.", [i+1, fmt(r.y,3), fmt(r.t,1)]);
    $('prev-step').disabled=i===0;$('next-step').disabled=i===current.records.length-1;
    if(comparisonEnabled)['A','B'].forEach(key=>{const s=stateAt(scenarioResults[key],cursor);$(key==='A'?'case-a-live':'case-b-live').textContent=tr(`${fmt(cursor,1)}s：温度 ${fmt(s.y)}°C ／ 出力 ${fmt(s.r.u)}%`,"{0}s: temperature {1}°C / output {2}%", [fmt(cursor,1), fmt(s.y), fmt(s.r.u)]);});
    updateCalculation(r,i);drawCursors();
  }
  function updateCalculation(r,i){
    const g=current.gains,c=config,n=v=>fmt(v,4),incremental=$('form').value==='incremental';
    const lines=[tr(`${comparisonEnabled?activeCase+' の ':''}計算 #${i+1}（t = ${fmt(r.t,1)} s）`,"{0}Calculation #{1} (t = {2} s)", [comparisonEnabled?activeCase+': ':'', i+1, fmt(r.t,1)]),
      tr(`誤差 e = 目標 − 測定温度 = ${n(c.target)} − ${n(r.y)} = ${n(r.e)} °C`,"Error e = target − measured temperature = {0} − {1} = {2} °C", [n(c.target), n(r.y), n(r.e)]),
      tr(`前回：e = ${n(r.prevError)} °C、I = ${n(r.prevI)} %、D = ${n(r.prevD)} %`,"Previous update: e = {0} °C, I = {1} %, D = {2} %", [n(r.prevError), n(r.prevI), n(r.prevD)]),
      tr(`前回の計算値 = ${n(r.prevRaw)} % ／ 前回の実出力 = ${n(r.prevU)} %`,"Previous calculated command = {0} % / previous actual output = {1} %", [n(r.prevRaw), n(r.prevU)]), ''];
    if(incremental){
      lines.push(tr(`ΔP = Kp × (今回e − 前回e) = ${n(g.Kp)} × (${n(r.e)} − ${n(r.prevError)}) = ${n(r.dp)} pt`,"ΔP = Kp × (current e − previous e) = {0} × ({1} − {2}) = {3} pt", [n(g.Kp), n(r.e), n(r.prevError), n(r.dp)]),
        tr(`ΔI の候補 = Ki × e × 制御周期 = ${n(g.Ki)} × ${n(r.e)} × ${n(c.Ts)} = ${n(r.proposedDi)} pt`,"Candidate ΔI = Ki × e × control period = {0} × {1} × {2} = {3} pt", [n(g.Ki), n(r.e), n(c.Ts), n(r.proposedDi)]));
    }else{
      lines.push(`P = Kp × e = ${n(g.Kp)} × ${n(r.e)} = ${n(r.P)} %`,
        tr(`I の増加候補 = Ki × e × 制御周期 = ${n(g.Ki)} × ${n(r.e)} × ${n(c.Ts)} = ${n(r.proposedDi)} pt`,"Candidate I increment = Ki × e × control period = {0} × {1} × {2} = {3} pt", [n(g.Ki), n(r.e), n(c.Ts), n(r.proposedDi)]));
    }
    if(r.integralHeld)lines.push(tr('出力制限をさらに超える方向の積分なので、今回の I 増加を 0 にします。','The proposed integral change would drive the command farther beyond an output limit, so this I increment is set to 0.'));
    lines.push(tr(`I = 前回I + 採用した増加 = ${n(r.prevI)} + ${n(r.di)} = ${n(r.I)} %`,"I = previous I + accepted increment = {0} + {1} = {2} %", [n(r.prevI), n(r.di), n(r.I)]));
    if(g.Kd){lines.push(tr(`D = {フィルター時間 × 前回D − Kd × (今回温度 − 前回温度)} / (フィルター時間 + 制御周期)`,"D = {filter time × previous D − Kd × (current temperature − previous temperature)} / (filter time + control period)"),
      `  = {${n(g.filterTime)} × ${n(r.prevD)} − ${n(g.Kd)} × (${n(r.y)} − ${n(r.prevY)})} / (${n(g.filterTime)} + ${n(c.Ts)}) = ${n(r.D)} %`);
    }else lines.push(tr('D = 0 %（微分作用は無効）','D = 0 % (derivative action disabled)'));
    if(incremental)lines.push(tr(`ΔD = 今回D − 前回D = ${n(r.D)} − ${n(r.prevD)} = ${n(r.dd)} pt`,"ΔD = current D − previous D = {0} − {1} = {2} pt", [n(r.D), n(r.prevD), n(r.dd)]),
      tr(`計算値 = 前回の計算値 + ΔP + ΔI + ΔD`,"Calculated command = previous calculated command + ΔP + ΔI + ΔD"),
      `  = ${n(r.prevRaw)} + (${n(r.dp)}) + (${n(r.di)}) + (${n(r.dd)}) = ${n(r.raw)} %`);
    else lines.push(tr(`計算値 = 基準出力 + P + I + D`,"Calculated command = base output + P + I + D"),
      `  = 0 + (${n(r.P)}) + (${n(r.I)}) + (${n(r.D)}) = ${n(r.raw)} %`);
    lines.push(tr(`実際のヒーター出力 = 計算値を 0〜${c.maxOutput}% に制限 = ${n(r.u)} %`,"Actual heater output = calculated command limited to 0–{0}% = {1} %", [c.maxOutput, n(r.u)]),
      tr(`実出力の前回からの増減 = ${n(r.u)} − ${n(r.prevU)} = ${n(r.appliedChange)} pt`,"Change in actual output since the previous update = {0} − {1} = {2} pt", [n(r.u), n(r.prevU), n(r.appliedChange)]));
    if(i===0)lines.push(tr('初期値：前回誤差・I・D・計算出力は 0。初回も制御周期 1 回分の積分を加える約束です。','Initial values: previous error, I, D and calculated command are 0. By convention, the first update also adds one control period of integration.'));
    $('calculation').textContent=lines.join('\n');
  }
  function stop(){if(timer!==null){cancelAnimationFrame(timer);timer=null;}$('play').textContent=tr('再生','Play');$('play').setAttribute('aria-pressed','false');}
  $('play').addEventListener('click',()=>{
    if(timer!==null){stop();return;}if(cursor>=config.horizon)cursor=0;
    $('play').textContent=tr('一時停止','Pause');$('play').setAttribute('aria-pressed','true');let last=performance.now();
    function tick(now){const dt=(now-last)/1000;last=now;setCursor(cursor+dt*config.horizon/30);if(cursor>=config.horizon)stop();else timer=requestAnimationFrame(tick);}
    timer=requestAnimationFrame(tick);
  });
  $('time-cursor').addEventListener('input',()=>{stop();setCursor(Number($('time-cursor').value));});
  $('prev-step').addEventListener('click',()=>{stop();const i=floorIndex(current.records,cursor);setCursor(current.records[Math.max(0,i-1)].t);});
  $('next-step').addEventListener('click',()=>{stop();const i=floorIndex(current.records,cursor);setCursor(current.records[Math.min(current.records.length-1,i+1)].t);});
  $('mode').addEventListener('change',()=>{stop();config.mode=$('mode').value;$('preset').value='custom';recompute();});
  $('form').addEventListener('change',()=>{stop();$('preset').value='custom';recompute();});
  $('antiWindup').addEventListener('change',()=>{config.antiWindup=$('antiWindup').checked;$('preset').value='custom';schedule();});
  $('compareForms').addEventListener('change',recompute);
  $('horizon').addEventListener('change',()=>{stop();config.horizon=Number($('horizon').value);recompute();});
  $('preset').addEventListener('change',()=>{stop();clearTimeout(pending);config=Object.assign({},PIDLab.DEFAULTS,presets[$('preset').value],{horizon:config.horizon});cursor=0;recompute();});
  $('save-reference').addEventListener('click',()=>{
    stop();recompute();
    reference={result:current,form:$('form').value};hidden.delete('ref-temperature');hidden.delete('ref-output');hidden.delete('ref-target');
    updateReferenceLabel();
    $('clear-reference').hidden=false;drawAll();
  });
  $('clear-reference').addEventListener('click',()=>{reference=null;$('reference-label').textContent='';$('clear-reference').hidden=true;drawAll();});
  $('view-mode').addEventListener('change',()=>setComparison($('view-mode').value==='compare'));
  $('edit-a').addEventListener('click',()=>loadCase('A'));
  $('edit-b').addEventListener('click',()=>loadCase('B'));
  $('copy-a-to-b').addEventListener('click',()=>{
    stop();clearTimeout(pending);rememberCase();
    scenarios.B={...scenarios.A,config:{...scenarios.A.config,horizon:config.horizon}};
    activeCase='B';config={...scenarios.B.config};$('form').value=scenarios.B.form;$('preset').value=scenarios.B.preset;recompute();
  });
  let resizeTimer;new ResizeObserver(()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>{drawAll();},100);}).observe($('temperature-chart'));
  window.addEventListener('pid-language-change',()=>{
    $('chart-tooltip').hidden=true;
    recompute();
  });
  $('preset').value='fast';updateLabels();recompute();
})();
