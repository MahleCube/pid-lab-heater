/* Educational heater model. No hardware connection. All times are seconds.
 * y' = (ambient + gain * delayedOutput - y) / tau.
 * Commands are held between controller updates; the plant is propagated exactly
 * across every delayed-command arrival, including fractional dead times.
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.PIDLab = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DEFAULTS = Object.freeze({
    ambient: 20, initial: 20, target: 30, gain: 0.5, tau: 60,
    deadTime: 10, Ts: 1, horizon: 600, Kp: 8, Ti: 80, Td: 2.5,
    mode: 'PID', maxOutput: 100, antiWindup: true, derivativeN: 10,
    bias: 0, tolerance: 0.1
  });
  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
  const number = (value, fallback, low, high) => {
    const n = Number(value);
    return clamp(Number.isFinite(n) ? n : fallback, low, high);
  };

  function normalize(input) {
    const a = input || {}, d = DEFAULTS;
    return {
      ambient: number(a.ambient, d.ambient, -100, 200),
      initial: number(a.initial, d.initial, -100, 400),
      target: number(a.target, d.target, -100, 400),
      gain: number(a.gain, d.gain, 0.001, 10),
      tau: number(a.tau, d.tau, 0.1, 6000),
      deadTime: number(a.deadTime, d.deadTime, 0, 600),
      Ts: number(a.Ts, d.Ts, 0.05, 60),
      horizon: number(a.horizon, d.horizon, 1, 3600),
      Kp: number(a.Kp, d.Kp, 0, 100),
      Ti: number(a.Ti, d.Ti, 0.1, 6000),
      Td: number(a.Td, d.Td, 0, 600),
      mode: ['P', 'PI', 'PID'].includes(a.mode) ? a.mode : d.mode,
      maxOutput: number(a.maxOutput, d.maxOutput, 0, 100),
      antiWindup: a.antiWindup === undefined ? d.antiWindup : Boolean(a.antiWindup),
      derivativeN: number(a.derivativeN, d.derivativeN, 1, 100),
      bias: number(a.bias, d.bias, 0, 100),
      tolerance: number(a.tolerance, d.tolerance, 0.001, 10)
    };
  }

  function gains(input) {
    const c = normalize(input);
    return {
      Kp: c.Kp,
      Ki: c.mode === 'P' ? 0 : c.Kp / c.Ti,
      Kd: c.mode === 'PID' ? c.Kp * c.Td : 0,
      filterTime: c.mode === 'PID' && c.Td > 0 ? Math.max(0.1, c.Td / c.derivativeN) : 0
    };
  }

  function advancePlant(y, output, duration, config) {
    const equilibrium = config.ambient + config.gain * output;
    // expm1 preserves accuracy for tiny elapsed times compared with tau.
    return y + (equilibrium - y) * (-Math.expm1(-duration / config.tau));
  }

  function makeController(c, form) {
    const g = gains(c);
    let oldError = 0, oldY = c.initial, oldI = 0, oldD = 0;
    let oldRaw = c.bias, oldApplied = clamp(c.bias, 0, c.maxOutput);
    return function update(t, y) {
      const e = c.target - y;
      const P = g.Kp * e;
      // Backward Euler low-pass filtered derivative, on measurement. A target
      // step therefore does not cause a derivative kick.
      const D = g.Kd === 0 ? 0 :
        g.filterTime / (g.filterTime + c.Ts) * oldD -
        g.Kd / (g.filterTime + c.Ts) * (y - oldY);
      const dp = g.Kp * (e - oldError);
      const dd = D - oldD;
      const proposedDi = g.Ki * e * c.Ts;
      const candidate = form === 'incremental'
        ? oldRaw + dp + proposedDi + dd
        : c.bias + P + oldI + proposedDi + D;
      // Conditional integration: suppress only integration that drives an
      // already out-of-range candidate farther out. Other terms still update.
      // Both forms retain the same *raw* command state. Storing the clipped
      // command only in the incremental form would change the controller.
      const integralHeld = c.antiWindup &&
        ((candidate > c.maxOutput + 1e-9 && proposedDi > 0) ||
         (candidate < -1e-9 && proposedDi < 0));
      const di = integralHeld ? 0 : proposedDi;
      const I = oldI + di;
      const raw = form === 'incremental'
        ? oldRaw + dp + di + dd
        : c.bias + P + I + D;
      const u = clamp(raw, 0, c.maxOutput);
      const row = {
        t, y, e, P, I, D, raw, u, command: u,
        du: raw - oldRaw, appliedChange: u - oldApplied,
        dp, di, dd, proposedDi, candidate,
        prevRaw: oldRaw, prevU: oldApplied,
        prevError: oldError, prevY: oldY, prevI: oldI, prevD: oldD,
        integralHeld,
        saturated: raw > c.maxOutput + 1e-9 || raw < -1e-9
      };
      oldError = e; oldY = y; oldI = I; oldD = D;
      oldRaw = raw; oldApplied = u;
      return row;
    };
  }

  function simulate(input, form) {
    const c = normalize(input);
    form = form === 'incremental' ? 'incremental' : 'position';
    const update = makeController(c, form);
    const records = [], samples = [], arrivals = [];
    const chartIntervals = Math.min(3600, Math.max(600, Math.ceil(c.horizon * 2)));
    const chartDt = c.horizon / chartIntervals;
    const epsilon = 1e-8;
    let time = 0, y = c.initial, applied = clamp(c.bias, 0, c.maxOutput);
    let controlIndex = 0, chartIndex = 0, arrivalIndex = 0, row = null;
    let peak = y, minimum = y, saturationTime = 0, integralHeldTime = 0;
    let settleTime = Math.abs(y - c.target) <= c.tolerance ? 0 : null;

    while (true) {
      const nextControl = controlIndex * c.Ts;
      const nextChart = chartIndex <= chartIntervals ? chartIndex * chartDt : Infinity;
      const nextArrival = arrivalIndex < arrivals.length ? arrivals[arrivalIndex].t : Infinity;
      const next = Math.min(nextControl, nextChart, nextArrival, c.horizon);
      const dt = Math.max(0, next - time);
      if (dt > 0) {
        const previousY = y;
        y = advancePlant(y, applied, dt, c);
        peak = Math.max(peak, y); minimum = Math.min(minimum, y);
        if (row && row.saturated) saturationTime += dt;
        if (row && row.integralHeld) integralHeldTime += dt;
        const isInside = Math.abs(y - c.target) <= c.tolerance;
        const wasInside = Math.abs(previousY - c.target) <= c.tolerance;
        if (!isInside) settleTime = null;
        else if (!wasInside) {
          // First-order motion under held input is monotone. Its crossing of
          // the tolerance boundary can be located analytically in this segment.
          const boundary = c.target + (previousY > c.target ? c.tolerance : -c.tolerance);
          const equilibrium = c.ambient + c.gain * applied;
          const ratio = (boundary - equilibrium) / (previousY - equilibrium);
          const crossing = ratio > 0 ? -c.tau * Math.log(ratio) : dt;
          settleTime = time + clamp(crossing, 0, dt);
        }
      }
      time = next;

      // A delayed command arriving exactly at a sample time changes the plant
      // input, but cannot instantaneously change its continuous temperature.
      while (arrivalIndex < arrivals.length && arrivals[arrivalIndex].t <= time + epsilon) {
        applied = arrivals[arrivalIndex].u;
        arrivalIndex++;
      }
      if (nextControl <= time + epsilon && nextControl <= c.horizon + epsilon) {
        row = update(time, y);
        if (c.deadTime <= epsilon) applied = row.u;
        else arrivals.push({ t: nextControl + c.deadTime, u: row.u });
        row.appliedDelayed = applied;
        records.push(row);
        controlIndex++;
      }
      if (nextChart <= time + epsilon && chartIndex <= chartIntervals) {
        samples.push(Object.assign({}, row, {
          t: time, y, e: c.target - y, appliedDelayed: applied,
          controlIndex: records.length - 1
        }));
        chartIndex++;
      }
      if (time >= c.horizon - epsilon) break;
    }

    const finalRow = Object.assign({}, row, {
      t: c.horizon, y, e: c.target - y, appliedDelayed: applied,
      controlIndex: records.length - 1
    });
    if (!samples.length || Math.abs(samples[samples.length - 1].t - c.horizon) > epsilon) samples.push(finalRow);
    const stats = {
      finalTemperature: y, finalError: c.target - y,
      peakTemperature: peak, minimumTemperature: minimum,
      overshoot: Math.max(0, peak - c.target),
      settleTime, tolerance: c.tolerance,
      saturationTime, saturationFraction: saturationTime / c.horizon,
      integralHeldTime, controlCount: records.length,
      finalOutput: row.u, finalRawOutput: row.raw,
      requiredSteadyOutput: (c.target - c.ambient) / c.gain,
      reachable: c.target >= c.ambient && c.target <= c.ambient + c.gain * c.maxOutput
    };
    return { config: c, form, gains: gains(c), records, samples, stats };
  }

  function compare(input) {
    const position = simulate(input, 'position');
    const incremental = simulate(input, 'incremental');
    let maxTemperatureDifference = 0, maxOutputDifference = 0, maxRawDifference = 0;
    for (let i = 0; i < position.records.length; i++) {
      const a = position.records[i], b = incremental.records[i];
      maxTemperatureDifference = Math.max(maxTemperatureDifference, Math.abs(a.y - b.y));
      maxOutputDifference = Math.max(maxOutputDifference, Math.abs(a.u - b.u));
      maxRawDifference = Math.max(maxRawDifference, Math.abs(a.raw - b.raw));
    }
    return { position, incremental, maxTemperatureDifference, maxOutputDifference, maxRawDifference };
  }

  return Object.freeze({ DEFAULTS, normalize, gains, advancePlant, simulate, compare });
});
