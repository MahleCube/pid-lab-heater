'use strict';
const assert = require('node:assert/strict');
const lab = require('./engine.js');
const close = (actual, expected, tolerance, label) => assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} versus ${expected}`);
let checks = 0;
function check(name, fn) { fn(); checks++; console.log(`PASS ${name}`); }

check('known first-order solution, with nonzero initial temperature', () => {
  const c = lab.normalize({ambient:20, gain:.5, tau:60});
  close(lab.advancePlant(25, 40, 30, c), 40 + (25 - 40) * Math.exp(-.5), 1e-12, 'exact solution');
});

check('fractional input delay and fractional control period', () => {
  // P output remains 100% throughout this short experiment, so the independent
  // analytic solution is a single delayed constant-input response.
  const c = {mode:'P', Kp:100, target:200, deadTime:1.37, Ts:.3, horizon:4.8, tau:60, maxOutput:100};
  const r = lab.simulate(c);
  for (const s of r.samples) {
    const expected = s.t <= 1.37 ? 20 : 20 + 50 * (1 - Math.exp(-(s.t - 1.37) / 60));
    close(s.y, expected, 3e-12, `delay at t=${s.t}`);
  }
});

check('P-only steady error equals the algebraic heat-loss balance', () => {
  const r = lab.simulate({mode:'P', Kp:2, horizon:1800});
  close(r.stats.finalTemperature, 25, 1e-9, 'P equilibrium');
  close(r.stats.finalOutput, 10, 1e-9, 'P output');
});

check('PI removes constant steady error and maintains heating at zero error', () => {
  const r = lab.simulate({mode:'PI', Kp:2, Ti:60, horizon:1800});
  close(r.stats.finalTemperature, 30, 1e-7, 'PI equilibrium');
  close(r.stats.finalOutput, 20, 1e-7, 'heat-loss compensation');
});

check('first and second control calculations preserve integral history', () => {
  const [a,b] = lab.simulate({Kp:8, Ti:80, Td:2.5, mode:'PID', Ts:1}).records;
  close(a.P,80,1e-12,'first P'); close(a.I,1,1e-12,'first I'); close(a.D,0,1e-12,'no derivative kick');
  close(a.u,81,1e-12,'first output'); close(b.I,2,1e-12,'second I'); close(b.u,82,1e-12,'second output');
  close(b.dp,0,1e-12,'second delta P'); close(b.di,1,1e-12,'second delta I');
});

let largestTemperatureError = 0, largestCommandError = 0;
check('independent position/increment controllers match with clipping and antiwindup', () => {
  for (const mode of ['P','PI','PID']) for (const antiWindup of [false,true]) {
    for (const config of [
      {Kp:8,Ti:80,Td:2.5,Ts:1},
      {Kp:20,Ti:5,Td:60,Ts:.1,deadTime:17.35,maxOutput:40,horizon:400},
      {Kp:17,Ti:7,Td:40,Ts:7.3,deadTime:12.7,initial:60,horizon:800},
      {Kp:0,Ti:20,Td:10,Ts:10,bias:13},
      {Kp:3,Ti:15,Td:1,Ts:.7,deadTime:0,bias:10}
    ]) {
      const result = lab.compare({...config,mode,antiWindup});
      largestTemperatureError = Math.max(largestTemperatureError, result.maxTemperatureDifference);
      largestCommandError = Math.max(largestCommandError, result.maxOutputDifference);
      assert.ok(result.maxTemperatureDifference < 1e-8, `${mode} temperature equivalent`);
      assert.ok(result.maxOutputDifference < 1e-7, `${mode} command equivalent`);
      for (const r of result.position.records) {
        assert.ok(Number.isFinite(r.raw) && Number.isFinite(r.y), 'finite states');
        assert.ok(r.u >= 0 && r.u <= result.position.config.maxOutput, 'actuator bounds');
      }
    }
  }
});

check('antiwindup suppresses integral growth when heating cannot reach target', () => {
  const config = {Kp:8,Ti:20,Td:0,mode:'PI',target:80,maxOutput:30,horizon:600};
  const on = lab.simulate({...config,antiWindup:true});
  const off = lab.simulate({...config,antiWindup:false});
  close(on.records.at(-1).I,0,1e-12,'held integrator');
  assert.ok(off.records.at(-1).I > 1000, 'windup demonstrated');
  assert.equal(on.stats.reachable,false);
  assert.ok(on.stats.saturationTime > 500);
});

check('reachable limit includes output ceiling and passive cooling', () => {
  assert.equal(lab.simulate({target:80}).stats.reachable,false);
  assert.equal(lab.simulate({target:10}).stats.reachable,false);
  assert.equal(lab.simulate({target:30}).stats.reachable,true);
});

check('settling time uses exact tolerance-band crossing and finite-horizon definition', () => {
  const r = lab.simulate({Kp:0,bias:20,deadTime:0,initial:20,target:30,horizon:600});
  close(r.stats.settleTime, 60*Math.log(100), 1e-8, 'analytic settling time');
  assert.equal(lab.simulate({Kp:0,initial:20,target:30}).stats.settleTime,null);
});

check('zero-delay, fast sample period, slow plant and longest horizon stay bounded', () => {
  const r = lab.simulate({Kp:20,Ti:5,Td:60,Ts:.1,deadTime:0,tau:300,horizon:1800,antiWindup:true});
  assert.ok(r.samples.length <= 3601, 'bounded chart payload');
  assert.equal(r.records.length,18001);
  for (const row of r.records) assert.ok(Number.isFinite(row.y) && Number.isFinite(row.D) && Number.isFinite(row.raw));
});

console.log(JSON.stringify({checks,largestTemperatureError,largestCommandError,defaultStats:lab.simulate().stats},null,2));
