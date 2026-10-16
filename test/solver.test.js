// Node tests for the solver (src/solver.js).
// Run: npm test   (or: npm run test:solver)
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// runInThisContext rather than a separate vm context: there every global lookup
// (Math, …) goes through interceptors and runs several times slower than a browser.
const file = path.join(__dirname, '..', 'src', 'solver.js');
vm.runInThisContext(fs.readFileSync(file, 'utf8'), { filename: file });
const S = globalThis.SpringSolver;

// Tests run on node:test. Checks are soft: every failing check in a test is
// reported, then the test fails.
const { test: nodeTest, after } = require('node:test');
const assert = require('node:assert');
let failures = 0;
let passes = 0;
let failed = []; // messages of the failing checks in the running test
function check(cond, msg) {
  if (cond) passes++;
  else {
    failures++;
    failed.push(msg);
    console.log(`  FAIL: ${msg}`);
  }
}
function test(name, fn) {
  nodeTest(name, () => {
    failed = [];
    fn();
    assert.deepStrictEqual(failed, [], `${failed.length} check(s) failed`);
  });
}
after(() => console.log(`\n${passes} checks passed, ${failures} failed`));
function solve(points, opts, modes) {
  const s = new S.Strip(Object.assign({ d: 6, t: 3 }, opts || {}));
  s.setPins(
    points.map((p, i) => ({ id: i + 1, x: p[0], y: p[1], mode: (modes && modes[i]) || 'auto' })),
  );
  s.solve(30000);
  return s;
}
function finiteResult(r) {
  return (
    r.nodes.every((q) => Number.isFinite(q[0]) && Number.isFinite(q[1])) &&
    Number.isFinite(r.length)
  );
}
// A random mode: 20% Through, then 15% of the rest Left or Right. The draws
// happen in this order, so the sequence of layouts stays the same.
function randomMode(rnd) {
  if (rnd() < 0.2) return 'through';
  if (rnd() >= 0.15) return 'auto';
  return rnd() < 0.5 ? 'left' : 'right';
}
// A seeded generator. Each test that draws numbers has its own, so adding or
// changing a test leaves the others' layouts alone.
function random(seed) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
}

// Independent check that a result is a stable equilibrium (none of the
// solver's own code): the KKT matrix, dense and equilibrated, factorised by
// Bunch–Kaufman LDLᵀ, has exactly as many negative eigenvalues as there are
// constraints, and no zero ones.
function stable(s) {
  const A = denseKKT(s);
  equilibrate(A);
  const { neg, zero } = inertia(A);
  return zero === 0 && neg === 2 * s.prob.L.K + (s.hold ? 1 : 0);
}

// The KKT matrix at the solution, bordered by the length row when held.
function denseKKT(s) {
  const P = s.prob;
  const L = P.L;
  const n = L.n;
  const N = n + (s.hold ? 1 : 0);
  const A = Array.from({ length: N }, () => new Float64Array(N));
  P.tau = s.hold ? s.nu : 0;
  S.evaluate(P, s.x, new Float64Array(n), (i, j, v) => {
    A[i][j] += v;
    if (i !== j) A[j][i] += v;
  });
  if (s.hold) {
    for (let k = 0; k < L.K; k++) {
      const ih = S.iH(L, k);
      A[n][ih] = L.m[k];
      A[ih][n] = L.m[k];
    }
  }
  return A;
}

// Symmetric scaling D·A·D towards unit row maxima (congruence keeps the inertia).
function equilibrate(A) {
  for (let it = 0; it < 30; it++) {
    const d = A.map((r) => {
      let m = 0;
      for (const v of r) m = Math.max(m, Math.abs(v));
      return m > 0 ? 1 / Math.sqrt(m) : 1;
    });
    for (let i = 0; i < A.length; i++) for (let j = 0; j < A.length; j++) A[i][j] *= d[i] * d[j];
  }
}

// Numbers of negative and zero eigenvalues, from Bunch–Kaufman LDLᵀ (A is overwritten).
function inertia(A) {
  let neg = 0;
  let zero = 0;
  for (let k = 0; k < A.length;) {
    const size = bkPivot(A, k);
    if (size === 0) {
      zero++;
      k++;
    } else if (size === 1) {
      if (A[k][k] < 0) neg++;
      eliminate1(A, k);
      k++;
    } else {
      neg += eliminate2(A, k);
      k += 2;
    }
  }
  return { neg, zero };
}

// Bunch–Kaufman pivoting at column k: swaps rows and columns as needed and
// returns the pivot size, 1 or 2 (0 for a zero column).
function bkPivot(A, k) {
  const alpha = (1 + Math.sqrt(17)) / 8;
  let r = k;
  let colmax = 0;
  for (let i = k + 1; i < A.length; i++) {
    if (Math.abs(A[i][k]) > colmax) {
      colmax = Math.abs(A[i][k]);
      r = i;
    }
  }
  const akk = Math.abs(A[k][k]);
  if (Math.max(akk, colmax) === 0) return 0;
  if (akk >= alpha * colmax) return 1;
  let rowmax = 0;
  for (let j = k; j < A.length; j++) if (j !== r) rowmax = Math.max(rowmax, Math.abs(A[r][j]));
  if (akk * rowmax >= alpha * colmax * colmax) return 1;
  if (Math.abs(A[r][r]) >= alpha * rowmax) {
    swap(A, k, r);
    return 1;
  }
  swap(A, k + 1, r);
  return 2;
}

function swap(A, i, j) {
  if (i === j) return;
  [A[i], A[j]] = [A[j], A[i]];
  for (const r of A) {
    const t = r[i];
    r[i] = r[j];
    r[j] = t;
  }
}

function eliminate1(A, k) {
  const d = A[k][k];
  for (let i = k + 1; i < A.length; i++) {
    const l = A[i][k] / d;
    if (l) for (let j = k + 1; j < A.length; j++) A[i][j] -= l * A[k][j];
  }
}

// Eliminate with the 2×2 pivot at k; returns its number of negative eigenvalues.
function eliminate2(A, k) {
  const a = A[k][k];
  const b = A[k][k + 1];
  const c = A[k + 1][k + 1];
  const det = a * c - b * b;
  for (let i = k + 2; i < A.length; i++) {
    const x1 = A[i][k];
    const x2 = A[i][k + 1];
    const l1 = (c * x1 - b * x2) / det;
    const l2 = (a * x2 - b * x1) / det;
    for (let j = k + 2; j < A.length; j++) A[i][j] -= l1 * A[k][j] + l2 * A[k + 1][j];
  }
  // one negative eigenvalue if det < 0, else both share the sign of the trace
  if (det < 0) return 1;
  return a + c < 0 ? 2 : 0;
}

// ------------------------------------------------------------------ banded LU
test('banded LU matches dense Gaussian elimination (random banded indefinite systems)', () => {
  const rnd = random(12345);
  for (let trial = 0; trial < 40; trial++) {
    const n = 5 + Math.floor(rnd() * 120);
    const b = 1 + Math.floor(rnd() * 12);
    const W = 3 * b + 1;
    const dense = Array.from({ length: n }, () => new Float64Array(n));
    for (let i = 0; i < n; i++) {
      for (let j = Math.max(0, i - b); j <= Math.min(n - 1, i + b); j++) {
        if (j < i) continue;
        const v = rnd() * 2 - 1;
        dense[i][j] = v;
        dense[j][i] = v; // symmetric, indefinite
      }
    }
    for (let i = 0; i < n; i += 3) dense[i][i] = 0; // zero diagonals force pivoting
    const A = new Float64Array(n * W);
    for (let i = 0; i < n; i++) {
      for (let j = Math.max(0, i - b); j <= Math.min(n - 1, i + b); j++) {
        A[i * W + (j - i + b)] = dense[i][j];
      }
    }
    const rhs = Float64Array.from({ length: n }, () => rnd() * 2 - 1);
    const x = Float64Array.from(rhs);
    const ok = S.bandLU(n, b, A, new Int32Array(n));
    // dense GE with partial pivoting
    const M = dense.map((r) => Array.from(r));
    const y = Array.from(rhs);
    for (let k = 0; k < n; k++) {
      let p = k;
      for (let i = k + 1; i < n; i++) if (Math.abs(M[i][k]) > Math.abs(M[p][k])) p = i;
      [M[k], M[p]] = [M[p], M[k]];
      [y[k], y[p]] = [y[p], y[k]];
      for (let i = k + 1; i < n; i++) {
        const l = M[i][k] / M[k][k];
        for (let j = k; j < n; j++) M[i][j] -= l * M[k][j];
        y[i] -= l * y[k];
      }
    }
    for (let i = n - 1; i >= 0; i--) {
      let s = y[i];
      for (let j = i + 1; j < n; j++) s -= M[i][j] * y[j];
      y[i] = s / M[i][i];
    }
    check(ok, 'bandLU reported singular');
    // re-factor (bandLU works in place) and solve
    const A2 = new Float64Array(n * W);
    for (let i = 0; i < n; i++) {
      for (let j = Math.max(0, i - b); j <= Math.min(n - 1, i + b); j++) {
        A2[i * W + (j - i + b)] = dense[i][j];
      }
    }
    const perm = new Int32Array(n);
    S.bandLU(n, b, A2, perm);
    S.bandSolve(n, b, A2, perm, x);
    let err = 0;
    let scale = 0;
    for (let i = 0; i < n; i++) {
      err = Math.max(err, Math.abs(x[i] - y[i]));
      scale = Math.max(scale, Math.abs(y[i]));
    }
    // residual of the banded solution against the original matrix
    let res = 0;
    for (let i = 0; i < n; i++) {
      let s = -rhs[i];
      for (let j = 0; j < n; j++) s += dense[i][j] * x[j];
      res = Math.max(res, Math.abs(s));
    }
    check(err <= 1e-8 * Math.max(1, scale), `trial ${trial}: n=${n} b=${b} max diff ${err}`);
    check(res < 1e-9 * Math.max(1, scale), `trial ${trial}: residual ${res}`);
  }
});

// ------------------------------------------------------------------ 3-point bend
test('symmetric 3-point bend: mirror symmetry, inside/outside, forces, sign conventions', () => {
  const s = solve([
    [0, 0],
    [100, 20],
    [200, 0],
  ]);
  const r = s.result();
  check(r.status === 'converged', `status ${r.status}`);
  const n = r.nodes.length;
  let asym = 0;
  for (let i = 0; i < n; i++) {
    const a = r.nodes[i];
    const b = r.nodes[n - 1 - i];
    asym = Math.max(asym, Math.abs(a[0] + b[0] - 200), Math.abs(a[1] - b[1]));
  }
  check(asym < 1e-6, `mirror asymmetry ${asym} mm`);
  check(r.pins[1].label === 'inside', `middle pin label ${r.pins[1].label}`);
  check(
    r.pins[0].label === 'outside' && r.pins[2].label === 'outside',
    `end labels ${r.pins[0].label},${r.pins[2].label}`,
  );
  const F = r.pins.map((p) => p.forceVec);
  const sum = [F[0][0] + F[1][0] + F[2][0], F[0][1] + F[1][1] + F[2][1]];
  const fmax = Math.max(...F.map((f) => Math.hypot(f[0], f[1])));
  check(Math.hypot(sum[0], sum[1]) < 1e-9 * fmax, `force sum ${sum}`);
  // sign convention: the force on the strip points from the pin centre towards the contact point (pins push)
  for (const p of r.pins) {
    const dx = p.contact[0] - p.x;
    const dy = p.contact[1] - p.y;
    check(p.forceVec[0] * dx + p.forceVec[1] * dy > 0, `pin ${p.id} force does not push`);
    check(p.press > 0, `pin ${p.id} press ${p.press}`);
  }
  // frictionless: the interior pin force is normal to the strip
  const p1 = r.pins[1];
  const f1 = Math.hypot(p1.forceVec[0], p1.forceVec[1]);
  const dir = [p1.contact[0] - p1.x, p1.contact[1] - p1.y];
  const dl = Math.hypot(dir[0], dir[1]);
  const cross = (p1.forceVec[0] * dir[1] - p1.forceVec[1] * dir[0]) / (f1 * dl);
  check(Math.abs(cross) < 1e-6, `middle force not normal: ${cross}`);
  // middle pin is pushed down (y down) means the strip passes below it: contact y > pin y
  check(p1.contact[1] > p1.y, 'middle contact should be on the far side of the bend');
});

// ------------------------------------------------------------------ linear beam theory
test('small deflection matches linear beam theory (natural cubic spline through contacts)', () => {
  const pts = [
    [0, 0],
    [100, 1.5],
    [230, -1],
    [330, 0.8],
    [420, 0],
  ];
  const s = solve(pts, { d: 0.2, t: 0.1 });
  const r = s.result();
  check(r.status === 'converged', `status ${r.status}`);
  const C = r.pins.map((p) => p.contact);
  // natural cubic spline y(x) through the contact points
  const k = C.length;
  const xs = C.map((c) => c[0]);
  const ys = C.map((c) => c[1]);
  const h = [];
  const al = [0];
  const l = [1];
  const mu = [0];
  const zz = [0];
  for (let i = 0; i < k - 1; i++) h.push(xs[i + 1] - xs[i]);
  for (let i = 1; i < k - 1; i++) {
    al.push((3 / h[i]) * (ys[i + 1] - ys[i]) - (3 / h[i - 1]) * (ys[i] - ys[i - 1]));
  }
  for (let i = 1; i < k - 1; i++) {
    l[i] = 2 * (xs[i + 1] - xs[i - 1]) - h[i - 1] * mu[i - 1];
    mu[i] = h[i] / l[i];
    zz[i] = (al[i] - h[i - 1] * zz[i - 1]) / l[i];
  }
  const c = new Array(k).fill(0);
  const b = [];
  const d = [];
  for (let j = k - 2; j >= 0; j--) {
    c[j] = j === 0 ? 0 : zz[j] - mu[j] * c[j + 1];
  }
  c[0] = 0;
  for (let j = 0; j < k - 1; j++) {
    b[j] = (ys[j + 1] - ys[j]) / h[j] - (h[j] * (c[j + 1] + 2 * c[j])) / 3;
    d[j] = (c[j + 1] - c[j]) / (3 * h[j]);
  }
  const spline = (x) => {
    let j = 0;
    while (j < k - 2 && x > xs[j + 1]) j++;
    const t = x - xs[j];
    return ys[j] + b[j] * t + c[j] * t * t + d[j] * t * t * t;
  };
  let err = 0;
  let amp = 0;
  for (const q of r.nodes) {
    err = Math.max(err, Math.abs(q[1] - spline(q[0])));
    amp = Math.max(amp, Math.abs(q[1]));
  }
  check(
    err < 0.01 * amp,
    `max deviation ${err.toExponential(2)} mm vs amplitude ${amp.toFixed(3)} mm`,
  );
});

// ------------------------------------------------------------------ scale invariance
test('scale invariance: 0.01×, 1×, 100× give the same shape in the same iterations', () => {
  const base = [
    [0, 0],
    [120, 60],
    [260, -30],
    [380, 40],
    [450, -20],
  ];
  const out = [];
  for (const k of [0.01, 1, 100]) {
    const s = solve(
      base.map((p) => [p[0] * k, p[1] * k]),
      { d: 8 * k, t: 4 * k },
    );
    const r = s.result();
    out.push({ k, r, iter: s.totalIter, m: Array.from(s.prob.L.m).join(',') });
  }
  const ref = out[1];
  for (const o of out) {
    check(o.r.status === ref.r.status, `status ${o.r.status} at ${o.k}`);
    check(o.iter === ref.iter, `iterations ${o.iter} at ${o.k}× vs ${ref.iter}`);
    check(o.m === ref.m, `segment counts differ at ${o.k}×`);
    let dev = 0;
    for (let i = 0; i < Math.min(o.r.nodes.length, ref.r.nodes.length); i++) {
      dev = Math.max(
        dev,
        Math.hypot(
          o.r.nodes[i][0] / o.k - ref.r.nodes[i][0],
          o.r.nodes[i][1] / o.k - ref.r.nodes[i][1],
        ),
      );
    }
    check(
      o.r.nodes.length === ref.r.nodes.length && dev < 1e-6,
      `shape differs at ${o.k}×: ${dev}`,
    );
  }
});

// ------------------------------------------------------------------ room scale
test('room scale: 6000×6000 mm with 30 mm pins converges', () => {
  const pts = [
    [300, 3000],
    [1200, 2100],
    [2400, 1800],
    [3600, 2500],
    [4500, 3900],
    [5400, 4300],
    [5800, 3500],
  ];
  const s = solve(pts, { d: 30, t: 12 });
  const r = s.result();
  check(r.status === 'converged', `status ${r.status}`);
  check(finiteResult(r), 'non-finite result');
  check(r.length > 6000 && r.length < 12000, `length ${r.length}`);
});

// ------------------------------------------------------------------ contact geometry
test('contact points lie exactly r_eff from the pin centre, along the normal', () => {
  const pts = [
    [0, 0],
    [80, 40],
    [170, -20],
    [260, 30],
    [330, 0],
  ];
  for (const d of [6, 20]) {
    const s = solve(pts, { d, t: 3 });
    const r = s.result();
    const rEff = d / 2 + 1.5;
    for (const p of r.pins) {
      if (!p.engaged) continue;
      const dx = p.contact[0] - p.x;
      const dy = p.contact[1] - p.y;
      const dist = Math.hypot(dx, dy);
      check(Math.abs(dist - rEff) < 1e-9 * 330, `pin ${p.id}: |Q-C| = ${dist} vs ${rEff}`);
      // tangent at the contact node: nearest node
      let bi = 0;
      let bd = Infinity;
      r.nodes.forEach((q, i) => {
        const dd = Math.hypot(q[0] - p.contact[0], q[1] - p.contact[1]);
        if (dd < bd) {
          bd = dd;
          bi = i;
        }
      });
      const t = r.tangents[bi];
      const along = (dx * Math.cos(t) + dy * Math.sin(t)) / dist;
      check(
        bd < 1e-6 && Math.abs(along) < 1e-7,
        `pin ${p.id}: contact not along the normal (${along})`,
      );
    }
  }
});

// ------------------------------------------------------------------ manual flip
test('manual flip of the middle pin releases it and the strip goes straight', () => {
  const s = solve([
    [0, 0],
    [100, 20],
    [200, 0],
  ]);
  const side = s.pins[1].side;
  const mode = side > 0 ? 'right' : 'left'; // the opposite side
  s.setPins([
    { id: 1, x: 0, y: 0, mode: 'auto' },
    { id: 2, x: 100, y: 20, mode },
    { id: 3, x: 200, y: 0, mode: 'auto' },
  ]);
  s.solve(10000);
  const r = s.result();
  check(r.status === 'converged', `status ${r.status}`);
  check(r.pins[1].engaged === false && r.pins[1].label === 'free', 'middle pin should be released');
  check(r.minRadius > 1000 * r.length, `strip not straight, min radius ${r.minRadius}`);
  // and back to auto: it bends again
  s.setPins([
    { id: 1, x: 0, y: 0, mode: 'auto' },
    { id: 2, x: 100, y: 20, mode: 'auto' },
    { id: 3, x: 200, y: 0, mode: 'auto' },
  ]);
  s.solve(10000);
  const r2 = s.result();
  check(r2.pins[1].engaged && r2.pins[1].label === 'inside', `auto again: ${r2.pins[1].label}`);
});

test('released manual pin re-engages when the strip cuts into it', () => {
  // pin 2 set to Left and sitting left of (above, on screen) a straight strip: not touching.
  // Then move it below the strip: the strip must still keep it on its left, so it engages.
  const s = solve(
    [
      [0, 0],
      [100, -30],
      [200, 0],
    ],
    {},
    ['auto', 'left', 'auto'],
  );
  let r = s.result();
  check(r.pins[1].engaged === false, 'should start released');
  s.setPins([
    { id: 1, x: 0, y: 0, mode: 'auto' },
    { id: 2, x: 100, y: 15, mode: 'left' },
    { id: 3, x: 200, y: 0, mode: 'auto' },
  ]);
  s.solve(10000);
  r = s.result();
  check(
    r.pins[1].engaged === true && r.status === 'converged',
    `should re-engage, got engaged=${r.pins[1].engaged} ${r.status}`,
  );
  check(r.pins[1].press > 0, 'engaged pin must push');
});

// ------------------------------------------------------------------ wrap / hairpin
test('wrap-around, hairpin and slide-out layouts: converge, no NaN, bounded, held when needed', () => {
  const wrap = solve([
    [0, 0],
    [100, 0],
    [150, 50],
    [100, 100],
    [50, 50],
    [100, 10],
  ]);
  const rw = wrap.result();
  check(['converged', 'friction'].includes(rw.status), `wrap status ${rw.status}`);
  check(finiteResult(rw), 'wrap: non-finite');
  check(rw.length < 1e3 * 500, `wrap length ${rw.length}`);
  let turn = 0;
  for (let i = 1; i < rw.tangents.length; i++) turn += rw.tangents[i] - rw.tangents[i - 1];
  check(
    Math.abs(turn) > Math.PI,
    `wrap should turn more than 180°, turned ${((turn * 180) / Math.PI).toFixed(0)}`,
  );

  // tight hairpin: on frictionless pins it has no stable resting shape (the
  // compact equilibrium with the strip curled inside the pins is a saddle), so
  // it slides out and is held
  const hp = solve([
    [0, 0],
    [100, 20],
    [0, 40],
  ]);
  const rh = hp.result();
  check(rh.status === 'friction' && rh.held, `hairpin status ${rh.status}`);
  check(stable(hp), 'hairpin: the shape is not a stable equilibrium');
  check(finiteResult(rh), 'hairpin: non-finite');
  check(rh.length < 100 * 2 * Math.hypot(100, 20), `hairpin length unbounded: ${rh.length}`);
  for (const p of rh.pins) check(p.press > 0, 'hairpin: auto pin pulls');

  // deep V: no frictionless resting shape; held at the length limit
  const dv = solve([
    [0, 0],
    [50, 150],
    [100, 0],
  ]);
  const rv = dv.result();
  const LrefV = 2 * Math.hypot(50, 150);
  check(rv.status === 'friction' && rv.held, `deep V status ${rv.status}`);
  check(finiteResult(rv), 'deep V: non-finite');
  check(
    Math.abs(rv.length - 2 * LrefV) < 1e-6 * LrefV,
    `deep V held at 2 × L_ref: ${rv.length} vs ${2 * LrefV}`,
  );
  check(
    rv.muReq > 0 && Number.isFinite(rv.muReq),
    `deep V reports the friction needed: ${rv.muReq}`,
  );
  const dv2 = solve(
    [
      [0, 0],
      [50, 150],
      [100, 0],
    ],
    { holdFactor: 1.5 },
  );
  check(
    Math.abs(dv2.result().length - 1.5 * LrefV) < 1e-6 * LrefV,
    'length limit setting is honoured',
  );

  const gentle = solve([
    [0, 0],
    [100, 20],
    [200, 0],
  ]);
  check(
    gentle.result().status === 'converged' && !gentle.result().held,
    'gentle bend wrongly held',
  );
});

// ------------------------------------------------------------------ refinement
test('refining: a stronger bend raises the segment count, segment angle stays near 3°', () => {
  let prevM = 0;
  const target = S.consts.SEG_TARGET;
  for (const dy of [5, 25, 60]) {
    const s = solve([
      [0, 0],
      [100, dy],
      [200, 0],
    ]);
    const L = s.prob.L;
    const x = s.x;
    let mTot = 0;
    for (let k = 0; k < L.K; k++) {
      mTot += L.m[k];
      let mx = 0;
      for (let j = 1; j < L.m[k]; j++) {
        mx = Math.max(mx, Math.abs(x[S.iTh(L, k, j)] - x[S.iTh(L, k, j - 1)]));
      }
      const ok =
        (mx <= 1.5 * target || L.m[k] === S.consts.M_MAX) &&
        (mx >= 0.5 * target || L.m[k] === S.consts.M_MIN);
      check(
        ok,
        `dy=${dy} stretch ${k}: m=${L.m[k]} max angle ${((mx * 180) / Math.PI).toFixed(2)}°`,
      );
    }
    check(mTot >= prevM, `segment count did not grow: ${mTot} after ${prevM}`);
    if (dy === 60) check(mTot > 16, 'strong bend should be refined beyond the minimum');
    prevM = mTot;
  }
});

// ------------------------------------------------------------------ random layouts
// The hard check on work is the count of Newton iterations (fresh candidates
// included), which does not depend on the machine: the solver runs in slices
// of a fixed number of iterations. The time is printed; PERF=1 also checks it.
const ITER_BASELINE = 428; // Newton iterations for these 16 layouts; update when the algorithm changes on purpose
test('random layouts of 5–30 pins converge; work and per-iteration time', () => {
  const rnd = random(1011621176);
  const start = S.work.iterations;
  let totMs = 0;
  let worst = 0;
  for (let trial = 0; trial < 16; trial++) {
    const n = 5 + Math.floor(rnd() * 26);
    const pts = [];
    let x = 0;
    for (let i = 0; i < n; i++) {
      x += 40 + rnd() * 60;
      pts.push([x, (rnd() - 0.5) * 80]);
    }
    const w0 = S.work.iterations;
    const t0 = performance.now();
    const s = new S.Strip({ d: 6, t: 3 });
    s.setPins(pts.map((p, i) => ({ id: i + 1, x: p[0], y: p[1], mode: 'auto' })));
    while (s.run(0, 50)) {
      /* next slice */
    }
    const ms = performance.now() - t0;
    const r = s.result();
    check(
      ['converged', 'friction'].includes(r.status),
      `trial ${trial} (${n} pins): ${r.status} after ${s.totalIter} iterations`,
    );
    check(finiteResult(r), `trial ${trial}: non-finite`);
    for (const p of r.pins) {
      if (p.engaged && p.mode === 'auto') {
        check(p.press > -1e-3 || p.marginal, `trial ${trial}: auto pin ${p.id} pulls (${p.press})`);
      }
    }
    totMs += ms;
    worst = Math.max(worst, ms / (S.work.iterations - w0));
  }
  const work = S.work.iterations - start;
  const avg = totMs / work;
  console.log(
    `  ${work} Newton iterations (baseline ${ITER_BASELINE}); average ${avg.toFixed(2)} ms per iteration (worst layout ${worst.toFixed(2)} ms)`,
  );
  check(
    work <= ITER_BASELINE * 1.2,
    `${work} Newton iterations, more than 20% over the baseline of ${ITER_BASELINE}: update ITER_BASELINE if that is intended`,
  );
  if (work < ITER_BASELINE * 0.8) {
    console.log('  well under the baseline: consider lowering ITER_BASELINE');
  }
  if (process.env.PERF) check(avg < 5, `iterations too slow: ${avg.toFixed(2)} ms`);
});

// ------------------------------------------------------------------ incremental edits
test('incremental edits: insert mid-strip, append at an end, drag, state round trip', () => {
  const s = solve([
    [0, 0],
    [100, 20],
    [200, 0],
  ]);
  // insert near the strip between pins 2 and 3
  const r0 = s.result();
  const q = r0.nodes[Math.floor(r0.nodes.length * 0.75)];
  const loc = s.locate(q[0], q[1] + 1);
  check(loc && loc.index === 2 && loc.dist < 2, `locate index ${loc && loc.index}`);
  const pins = [
    { id: 1, x: 0, y: 0, mode: 'auto' },
    { id: 2, x: 100, y: 20, mode: 'auto' },
    { id: 3, x: 200, y: 0, mode: 'auto' },
  ];
  pins.splice(loc.index, 0, { id: 4, x: q[0], y: q[1] + 1, mode: 'auto' });
  s.setPins(pins);
  s.solve(10000);
  check(
    ['converged', 'friction'].includes(s.status) && finiteResult(s.result()),
    `after insert: ${s.status}`,
  );
  // append at the end and drag it in small steps, like the UI does
  pins.push({ id: 5, x: 260, y: 40, mode: 'auto' });
  s.setPins(pins);
  for (let i = 0; i < 40; i++) {
    pins[4].x = 260 + i * 2;
    pins[4].y = 40 + i * 1.5;
    s.setPins(pins);
    s.run(8);
  }
  s.solve(10000);
  const r1 = s.result();
  check(r1.status === 'converged' && finiteResult(r1), `after drag: ${r1.status}`);
  // round trip
  const st = JSON.parse(JSON.stringify(s.getState()));
  const s2 = new S.Strip({ d: 6, t: 3 });
  s2.setState(st);
  s2.solve(10000);
  const r2 = s2.result();
  let dev = 0;
  for (let i = 0; i < Math.min(r1.nodes.length, r2.nodes.length); i++) {
    dev = Math.max(
      dev,
      Math.hypot(r1.nodes[i][0] - r2.nodes[i][0], r1.nodes[i][1] - r2.nodes[i][1]),
    );
  }
  check(r1.nodes.length === r2.nodes.length && dev < 1e-6, `round trip shape differs by ${dev}`);
  check(s2.totalIter <= 3, `round trip should start converged, took ${s2.totalIter}`);
});

test('drag into a slide-out layout and back: length follows the layout, no hysteresis', () => {
  // (100,100), (100,200), (300,100): drag the last pin towards the first, then away again
  const s = new S.Strip({ d: 6, t: 3 });
  const pins = [
    { id: 1, x: 100, y: 100, mode: 'auto' },
    { id: 2, x: 100, y: 200, mode: 'auto' },
    { id: 3, x: 300, y: 100, mode: 'auto' },
  ];
  s.setPins(pins);
  s.solve(10000);
  const Lref = () =>
    Math.hypot(pins[1].x - pins[0].x, pins[1].y - pins[0].y) +
    Math.hypot(pins[2].x - pins[1].x, pins[2].y - pins[1].y);
  let maxRatio = 0;
  const route = [];
  for (let x = 300; x >= 104; x -= 4) route.push(x);
  for (let x = 104; x <= 300; x += 4) route.push(x);
  for (const x of route) {
    pins[2].x = x;
    s.setPins(pins);
    for (let f = 0; f < 3; f++) s.run(8);
    maxRatio = Math.max(maxRatio, s.result().length / Lref());
  }
  check(
    maxRatio <= 2 * (1 + 1e-6) + 0.05,
    `length exceeded the limit while dragging: ${maxRatio.toFixed(3)} × L_ref`,
  );
  s.solve(10000);
  const fresh = new S.Strip({ d: 6, t: 3 });
  fresh.setPins(pins);
  fresh.solve(10000);
  check(
    Math.abs(s.result().length - fresh.result().length) < 1e-6 * Lref(),
    `after dragging back: ${s.result().length} vs fresh ${fresh.result().length}`,
  );
  // move to a layout with a frictionless resting shape: the hold lets go
  pins[2].y = 400;
  s.setPins(pins);
  s.solve(10000);
  const r = s.result();
  check(
    r.status === 'converged' && !r.held && r.length < 1.2 * Lref(),
    `recovers to the free shape: ${r.status} ${r.length.toFixed(1)} mm`,
  );
});

test('square U of Right pins: drag the last pin past the snap-off and back (test.svg)', () => {
  // the strip runs inside the U; dragging pin 4 down towards pin 3 makes the
  // strip snap off pins 2 and 3, and dragging it back must thread it again
  const pins = [
    [100, 100],
    [100, 200],
    [200, 200],
    [200, 100],
  ].map(([x, y], i) => ({ id: i + 1, x, y, mode: 'right' }));
  const s = new S.Strip({ d: 6, t: 3, holdFactor: 1.5 });
  s.setPins(pins);
  s.solve(10000);
  const engaged = () =>
    s
      .result()
      .pins.map((p) => (p.engaged ? 'E' : '-'))
      .join('');
  check(engaged() === 'EEEE' && s._valid(), 'starts threaded through all four pins');
  const L0 = s.result().length;
  for (let y = 100; y <= 190; y += 2) {
    pins[3].y = y;
    s.setPins(pins);
    for (let f = 0; f < 3; f++) s.run(8);
  }
  s.solve(10000);
  check(
    engaged() === 'E--E' && s._valid() && s.result().status === 'converged',
    `past the snap-off: pins 2 and 3 released, valid: ${engaged()}`,
  );
  for (let y = 190; y >= 100; y -= 2) {
    pins[3].y = y;
    s.setPins(pins);
    for (let f = 0; f < 3; f++) s.run(8);
  }
  s.solve(10000);
  check(engaged() === 'EEEE' && s._valid(), `dragged back: threaded again, got ${engaged()}`);
  check(
    Math.abs(s.result().length - L0) < 1e-4 * L0,
    `same shape as at the start: ${s.result().length} vs ${L0}`,
  );
  // every settled layout along the way is a valid resting shape (no Left/Right pin pulls)
  for (let y = 100; y <= 190; y += 6) {
    const f = new S.Strip({ d: 6, t: 3, holdFactor: 1.5 });
    f.setPins(pins.map((p, i) => (i === 3 ? { ...p, y } : p)));
    f.solve(10000);
    check(f._valid(), `invalid resting shape at y4 = ${y}`);
  }
});

test('U with alternating Left/Right pins: pull the bottom pin down past the slide-out (test2.svg)', () => {
  // the strip wraps under pin 3; moving it down, the strip would slide out
  // there and is held, at a length that keeps it on every pin
  const pins = [
    [100, 100, 'left'],
    [110, 200, 'right'],
    [150, 250, 'left'],
    [190, 200, 'right'],
    [200, 100, 'left'],
  ].map(([x, y, mode], i) => ({ id: i + 1, x, y, mode }));
  const s = new S.Strip({ d: 6, t: 3, holdFactor: 1.5 });
  s.setPins(pins);
  s.solve(10000);
  check(s.result().pins.every((p) => p.engaged) && s._valid(), 'starts on all five pins');
  for (let y = 250; y <= 330; y += 2) {
    pins[2].y = y;
    s.setPins(pins);
    for (let f = 0; f < 3; f++) s.run(8);
  }
  s.solve(20000);
  const r = s.result();
  const Lref = pins
    .slice(1)
    .reduce((a, p, i) => a + Math.hypot(p.x - pins[i].x, p.y - pins[i].y), 0);
  check(
    r.pins.every((p) => p.engaged) && s._valid(),
    `still on all five pins, all pushing: ${r.pins
      .map((p) => (p.engaged ? p.press.toFixed(2) : '-'))
      .join(' ')}`,
  );
  let bottom = -Infinity;
  for (const q of r.nodes) bottom = Math.max(bottom, q[1]);
  check(
    Math.abs(bottom - (330 + r.rEff)) < 1,
    `the strip wraps just under pin 3, bottom at ${bottom.toFixed(1)}`,
  );
  check(
    r.held && r.length < 1.5 * Lref,
    `held below the length limit: ${(r.length / Lref).toFixed(3)} × L_ref`,
  );
  const f = new S.Strip({ d: 6, t: 3, holdFactor: 1.5 });
  f.setPins(pins);
  f.solve(20000);
  check(
    Math.abs(f.result().length - r.length) < 1e-3 * r.length,
    `same as a fresh solve: ${f.result().length} vs ${r.length}`,
  );
});

test('Through pins: the centreline passes through the pin centre, never lets go, slides freely', () => {
  const pins = [
    [0, 0],
    [100, 20, 'through'],
    [200, -10],
    [300, 30, 'through'],
    [400, 0, 'through'],
  ].map(([x, y, mode], i) => ({ id: i + 1, x, y, mode: mode || 'auto' }));
  const s = new S.Strip({ d: 6, t: 3 });
  s.setPins(pins);
  s.solve(10000);
  let r = s.result();
  check(r.status === 'converged', `status ${r.status}`);
  for (const p of r.pins) {
    const d = Math.hypot(p.contact[0] - p.x, p.contact[1] - p.y);
    if (p.mode === 'through') {
      check(p.engaged && p.label === 'through' && d < 1e-9, `through pin ${p.id}: offset ${d}`);
    } else check(Math.abs(d - r.rEff) < 1e-9, `auto pin ${p.id}: offset ${d} vs ${r.rEff}`);
  }
  // drag the middle Through pin far to the other side and beyond: it never releases
  for (let y = 20; y >= -120; y -= 4) {
    pins[1].y = y;
    s.setPins(pins);
    for (let f = 0; f < 3; f++) s.run(8);
  }
  s.solve(10000);
  r = s.result();
  check(
    r.pins[1].engaged && Math.hypot(r.pins[1].contact[0] - 100, r.pins[1].contact[1] + 120) < 1e-9,
    'still threaded through pin 2',
  );
  check(['converged', 'friction'].includes(r.status) && s._valid(), `settles validly: ${r.status}`);
  // every mode switch works and Through returns to the same shape
  const L0 = r.length;
  for (const m of ['auto', 'left', 'right', 'through']) {
    pins[1].mode = m;
    s.setPins(pins);
    s.solve(10000);
    check(finiteResult(s.result()), `mode ${m}`);
  }
  check(Math.abs(s.result().length - L0) < 1e-4 * L0, 'back to Through gives the same shape');
});

test('edge cases: 0, 1, 2 pins, coincident pins', () => {
  const s = new S.Strip({ d: 6, t: 3 });
  s.setPins([]);
  check(s.result().status === 'empty', '0 pins');
  s.setPins([{ id: 1, x: 5, y: 5, mode: 'auto' }]);
  check(s.result().status === 'empty' && s.result().nodes.length === 0, '1 pin');
  s.setPins([
    { id: 1, x: 5, y: 5, mode: 'auto' },
    { id: 2, x: 105, y: 45, mode: 'auto' },
  ]);
  s.solve();
  const r = s.result();
  // straight up to the slip-resistance pull on the end pins (radius > 1000 × length)
  check(
    r.status === 'converged' && r.minRadius > 1000 * r.length,
    `2 pins straight: ${r.status} ${r.minRadius}`,
  );
  s.setPins([
    { id: 1, x: 5, y: 5, mode: 'auto' },
    { id: 2, x: 105, y: 45, mode: 'auto' },
    { id: 3, x: 105, y: 45, mode: 'auto' },
  ]);
  s.solve(5000);
  check(finiteResult(s.result()), 'coincident pins produced NaN');
});

// ------------------------------------------------------------------ pins at the same position
// The mode two pins at one position share, or null when they cannot share a contact.
function sharedMode(a, b) {
  if ((a === 'through') !== (b === 'through')) return null;
  if (a === 'through') return 'through';
  if (a !== 'auto' && b !== 'auto' && a !== b) return null;
  return a !== 'auto' ? a : b;
}
function solveWithIds(pts, modes, ids) {
  const s = new S.Strip({ d: 6, t: 3 });
  s.setPins(pts.map((p, i) => ({ id: ids[i], x: p[0], y: p[1], mode: modes[i] })));
  s.solve(30000);
  return s;
}
// layouts with pins a and a+1 at one position, in the interior, at the start and at the end
const SAME_POSITION = [
  {
    name: 'interior',
    pts: [
      [0, 0],
      [100, 30],
      [200, 0],
      [200, 0],
      [300, 30],
    ],
    a: 2,
  },
  {
    name: 'start',
    pts: [
      [0, 0],
      [0, 0],
      [100, 30],
      [200, 0],
    ],
    a: 0,
  },
  {
    name: 'end',
    pts: [
      [0, 0],
      [100, 30],
      [200, 0],
      [200, 0],
    ],
    a: 2,
  },
];
// One pair of modes at one position: reported as invalid, or exactly the
// layout with one pin there, in the mode the two share.
function checkSamePosition(lay, ma, mb) {
  const tag = `${lay.name} pair ${ma}+${mb}`;
  const modes = lay.pts.map(() => 'auto');
  modes[lay.a] = ma;
  modes[lay.a + 1] = mb;
  const ids = lay.pts.map((_, i) => i + 1);
  const r = solveWithIds(lay.pts, modes, ids).result();
  check(finiteResult(r), `${tag}: non-finite`);
  const m = sharedMode(ma, mb);
  if (m === null) {
    check(
      r.status === 'invalid' &&
        r.invalid.length === 1 &&
        r.invalid[0].a === lay.a + 1 &&
        r.invalid[0].b === lay.a + 2,
      `${tag}: should be invalid, got ${r.status}`,
    );
    return;
  }
  const others = (_, i) => i !== lay.a + 1;
  const refModes = modes.filter(others);
  refModes[lay.a] = m;
  const ref = solveWithIds(lay.pts.filter(others), refModes, ids.filter(others)).result();
  check(
    r.status === ref.status && Math.abs(r.length - ref.length) <= 1e-9 * ref.length,
    `${tag}: ${r.status} ${r.length} vs one pin ${ref.status} ${ref.length}`,
  );
  const pa = r.pins[lay.a];
  const pb = r.pins[lay.a + 1];
  check(
    pa.warnings.includes('duplicate') &&
      pb.warnings.includes('duplicate') &&
      pa.sameAs[0] === pb.id,
    `${tag}: duplicate warning`,
  );
  check(
    pb.mode === mb &&
      pa.engaged === pb.engaged &&
      (!pa.contact || (pa.contact[0] === pb.contact[0] && pa.contact[1] === pb.contact[1])),
    `${tag}: both pins report the shared contact`,
  );
}

test('neighbouring pins at the same position act as one pin, or are reported when they cannot', () => {
  const MODES = ['through', 'auto', 'left', 'right'];
  for (const lay of SAME_POSITION) {
    for (const ma of MODES) for (const mb of MODES) checkSamePosition(lay, ma, mb);
  }
});

test('pins at one position: an eyelet, only two pins, overlaps, settings, coordinates', () => {
  const run = solveWithIds;
  // two Through pins at one position (one eyelet) used to fail
  const tt = run(
    [
      [0, 0],
      [100, 30],
      [200, 0],
      [200, 0],
      [300, 30],
    ],
    Array(5).fill('through'),
    [1, 2, 3, 4, 5],
  );
  check(tt.status === 'converged', `two Through pins at one position: ${tt.status}`);
  const st = tt.getState();
  check(
    st.pins.length === 5 && st.pins.every((p) => p.mode === 'through'),
    'getState keeps every pin as given',
  );
  const loc = tt.locate(250, 15);
  check(
    loc && loc.index === 4,
    `locate gives the index among the pins as given: ${loc && loc.index}`,
  );
  // only two pins, at one position: nothing to solve
  const two = run(
    [
      [50, 50],
      [50, 50],
    ],
    ['auto', 'left'],
    [1, 2],
  );
  const r2 = two.result();
  check(
    two.status === 'empty' &&
      r2.pins.length === 2 &&
      r2.pins.every((p) => p.warnings.includes('duplicate')),
    `two pins at one position: ${two.status}`,
  );
  // closer than the pin diameter but not at one position: an overlap warning
  for (const [gap, want] of [
    [0.01, true],
    [5.9, true],
    [6, false],
    [20, false],
  ]) {
    const r = run(
      [
        [0, 0],
        [100, 30],
        [200, 0],
        [200 + gap, 0],
        [300, 30],
      ],
      Array(5).fill('auto'),
      [1, 2, 3, 4, 5],
    ).result();
    check(
      r.pins[2].warnings.includes('overlap') === want &&
        r.pins[3].warnings.includes('overlap') === want,
      `pins ${gap} mm apart (d = 6 mm): overlap warning ${want ? '' : 'not '}expected`,
    );
  }
  // an invalid layout stays invalid through a settings change; compatible modes solve it
  const bad = run(
    [
      [0, 0],
      [100, 30],
      [100, 30],
      [200, 0],
    ],
    ['auto', 'left', 'right', 'auto'],
    [1, 2, 3, 4],
  );
  bad.setSettings({ d: 8 });
  bad.solve(10000);
  check(bad.status === 'invalid', `invalid after a settings change: ${bad.status}`);
  bad.setPins(
    [
      [0, 0],
      [100, 30],
      [100, 30],
      [200, 0],
    ].map((p, i) => ({ id: i + 1, x: p[0], y: p[1], mode: ['auto', 'left', 'left', 'auto'][i] })),
  );
  bad.solve(10000);
  check(
    ['converged', 'friction'].includes(bad.status) && !bad.result().invalid.length,
    `compatible modes solve: ${bad.status}`,
  );
  let threw = false;
  try {
    new S.Strip().setPins([
      { id: 1, x: '0', y: 0 },
      { id: 2, x: 100, y: 0 },
    ]);
  } catch {
    threw = true;
  }
  check(threw, 'a coordinate that is not a number is refused');
});

// ------------------------------------------------------------------ stability
test('stability: every shape reported is a stable equilibrium, also near the slide-out limit', () => {
  const rnd = random(1072029924);
  // Through hairpins across the depth where the stable shape stops existing;
  // the unstable equilibrium there used to be reported as converged
  const statuses = [];
  for (let ratio = 1; ratio <= 4.001; ratio += 0.125) {
    const s = solve(
      [
        [0, 0],
        [ratio * 40, 20],
        [0, 40],
      ],
      {},
      ['through', 'through', 'through'],
    );
    statuses.push({ friction: 'H', converged: 'C' }[s.status] || s.status);
    check(
      ['converged', 'friction'].includes(s.status) && stable(s),
      `Through hairpin ${ratio}× as deep as wide: ${s.status}, stable ${stable(s)}`,
    );
  }
  // so the status does not flicker while a pin is dragged deeper
  check(/^C+H+$/.test(statuses.join('')), `statuses with growing depth: ${statuses.join('')}`);
  for (let trial = 0; trial < 12; trial++) {
    const n = 3 + Math.floor(rnd() * 10);
    const pts = [];
    const modes = [];
    let x = 0;
    for (let i = 0; i < n; i++) {
      x += 40 + rnd() * 80;
      pts.push([x, (rnd() - 0.5) * 160]);
      modes.push(randomMode(rnd));
    }
    const s = solve(pts, {}, modes);
    check(
      stable(s) && !s.result().unstable,
      `random layout ${trial} (${n} pins, ${s.status}): not a stable equilibrium`,
    );
  }
});

// ------------------------------------------------------------------ slide-out work targets
// Layouts that slide out; a hairpin first passes through an unstable
// equilibrium and is pushed off it. Targets: Newton iterations to settle (fresh
// re-solves included), iterations until the held shape appears (within 5% of
// its final length), and searches for an unstable direction. Iterations are
// counted, not timed, so the targets hold on any machine; they allow 20% more.
// PERF=1 also checks times. Update a target when a change is meant to alter it.
const SLIDE_TARGETS = [
  // name, pins, mode, warm start from (or null), [iterations, until the held shape, direction searches]
  [
    'Auto hairpin, fresh',
    [
      [0, 0],
      [100, 20],
      [0, 40],
    ],
    'auto',
    null,
    [60, 49, 1],
  ],
  [
    'Through hairpin, fresh',
    [
      [0, 0],
      [100, 20],
      [0, 40],
    ],
    'through',
    null,
    [60, 45, 1],
  ],
  [
    'Through hairpin, one edit deeper',
    [
      [0, 0],
      [100, 20],
      [0, 40],
    ],
    'through',
    [
      [0, 0],
      [40, 20],
      [0, 40],
    ],
    [91, 17, 2],
  ],
  [
    'deep V, fresh',
    [
      [0, 0],
      [50, 150],
      [100, 0],
    ],
    'auto',
    null,
    [40, 23, 0],
  ],
];
const SWEEP_TARGET = 898; // Newton iterations for the 25 Through hairpins of the depth sweep, fresh
// One slide-out case, the way the page runs it but one Newton iteration per
// call: iterations to settle, iterations until the held shape appears (within
// 5% of its final length), and unstable-direction searches.
function slideWork(pts, mode, from) {
  const pinsOf = (list) => list.map((q, i) => ({ id: i + 1, x: q[0], y: q[1], mode }));
  const s = new S.Strip({ d: 6, t: 3 });
  if (from) {
    s.setPins(pinsOf(from));
    s.solve(10000);
  }
  s.setPins(pinsOf(pts));
  const w0 = S.work.iterations;
  const q0 = S.work.searches;
  const lens = [];
  while (s.run(0, 1)) lens.push([S.work.iterations - w0, s.result().length]);
  const final = s.result().length;
  const held = lens.find((l) => Math.abs(l[1] - final) <= 0.05 * final);
  return {
    status: s.status,
    it: S.work.iterations - w0,
    toHeld: held ? held[0] : 0,
    searches: S.work.searches - q0,
  };
}

test('slide-out work stays within targets (hairpins, deep V)', () => {
  S.work.slowestSearchMs = 0;
  for (const [name, pts, mode, from, [maxIt, maxHeld, maxSearch]] of SLIDE_TARGETS) {
    const { status, it, toHeld, searches: n } = slideWork(pts, mode, from);
    console.log(
      `  ${name}: ${it} iterations (target ${maxIt}), held shape after ${toHeld} (target ${maxHeld}), ${n} direction search${n === 1 ? '' : 'es'} (target ${maxSearch})`,
    );
    check(status === 'friction', `${name}: ${status}`);
    check(it <= maxIt * 1.2, `${name}: ${it} iterations, over the target of ${maxIt}`);
    check(
      toHeld <= maxHeld * 1.2,
      `${name}: the held shape appears after ${toHeld} iterations, over the target of ${maxHeld}`,
    );
    check(
      n <= maxSearch,
      `${name}: ${n} unstable-direction searches, over the target of ${maxSearch}`,
    );
  }
  const w0 = S.work.iterations;
  for (let ratio = 1; ratio <= 4.001; ratio += 0.125) {
    const s = new S.Strip({ d: 6, t: 3 });
    const pts = [
      [0, 0],
      [ratio * 40, 20],
      [0, 40],
    ];
    s.setPins(pts.map((q, i) => ({ id: i + 1, x: q[0], y: q[1], mode: 'through' })));
    while (s.run(0, 50)) {
      /* next slice */
    }
  }
  const sweep = S.work.iterations - w0;
  console.log(`  depth sweep of 25 Through hairpins: ${sweep} iterations (target ${SWEEP_TARGET})`);
  check(
    sweep <= SWEEP_TARGET * 1.2,
    `depth sweep: ${sweep} iterations, over the target of ${SWEEP_TARGET}`,
  );
  if (process.env.PERF) {
    const t0 = performance.now();
    solve([
      [0, 0],
      [100, 20],
      [0, 40],
    ]);
    const ms = performance.now() - t0;
    const slowest = S.work.slowestSearchMs;
    console.log(
      `  fresh Auto hairpin settles in ${ms.toFixed(0)} ms; slowest unstable-direction search ${slowest.toFixed(1)} ms`,
    );
    check(ms < 150, `fresh Auto hairpin took ${ms.toFixed(0)} ms (target 150 ms)`);
    check(slowest < 15, `unstable-direction search took ${slowest.toFixed(1)} ms (target 15 ms)`);
  }
});

// ------------------------------------------------------------------ failures, limits, frame budget
test('a failed solve keeps the last good shape, marked stale when it was for an earlier layout', () => {
  const pins = [
    [0, 0],
    [100, 20],
    [200, 0],
  ].map((p, i) => ({ id: i + 1, x: p[0], y: p[1], mode: 'auto' }));
  const fail = function () {
    this.mu = 1e14;
    return 'rejected';
  }; // every Newton step fails
  const s = new S.Strip({ d: 6, t: 3 });
  s.setPins(pins);
  s.solve(10000);
  const L0 = s.result().length;
  check(!s.result().stale && s.getState().shape, 'converged: not stale, shape saved');
  const iterate = s._iterate;
  s._iterate = fail;
  pins[1].y = 40;
  s.setPins(pins);
  s.solve(1000);
  let r = s.result();
  check(
    r.status === 'failed' && r.stale && Math.abs(r.length - L0) < 1e-9 * L0,
    `failed after an edit: ${r.status}, stale ${r.stale}`,
  );
  check(s.getState().shape === null, 'a stale shape is not saved');
  s._iterate = iterate;
  pins[1].y = 20;
  s.setPins(pins);
  s.solve(10000);
  r = s.result();
  check(
    r.status === 'converged' && !r.stale && Math.abs(r.length - L0) < 1e-6 * L0,
    `the next edit solves again: ${r.status}`,
  );
  // failing with no good shape at all: the attempt is for this layout, but not saved either
  const f = new S.Strip({ d: 6, t: 3 });
  f._iterate = fail;
  f.setPins(pins);
  f.solve(1000);
  check(
    f.status === 'failed' && !f.result().stale && f.getState().shape === null,
    `failed first solve: ${f.status}`,
  );
});

test('restoring a state (undo, open) searches the held length afresh', () => {
  const mk = (pts, modes) =>
    pts.map((p, i) => ({ id: i + 1, x: p[0], y: p[1], mode: modes[i] || modes }));
  // a U of alternating Left/Right pins pulled deep: held below the length limit
  const U = mk(
    [
      [100, 100],
      [110, 200],
      [150, 330],
      [190, 200],
      [200, 100],
    ],
    ['left', 'right', 'left', 'right', 'left'],
  );
  const s = new S.Strip({ d: 6, t: 3, holdFactor: 1.5 });
  s.setPins(U);
  s.solve(20000);
  check(s.result().heldBelowLimit, 'the U is held below the length limit');
  // then a deep V is restored into the same solver, as undo or Open do
  const V = {
    pins: mk(
      [
        [0, 0],
        [50, 150],
        [100, 0],
      ],
      'auto',
    ),
    shape: null,
  };
  s.setState(JSON.parse(JSON.stringify(V)));
  s.solve(20000);
  const fresh = new S.Strip({ d: 6, t: 3, holdFactor: 1.5 });
  fresh.setState(JSON.parse(JSON.stringify(V)));
  fresh.solve(20000);
  const a = s.result();
  const b = fresh.result();
  check(
    Math.abs(a.length - b.length) < 1e-6 * b.length && a.heldBelowLimit === b.heldBelowLimit,
    `the restored V is held like a fresh one: ${a.length.toFixed(1)} mm vs ${b.length.toFixed(1)} mm, below the limit ${a.heldBelowLimit} vs ${b.heldBelowLimit}`,
  );
});

test('contacts that never settle end "stalled", not "converged"', () => {
  const s = new S.Strip({ d: 6, t: 3 });
  s.setPins(
    [
      [0, 0],
      [100, 20],
      [200, 0],
    ].map((p, i) => ({ id: i + 1, x: p[0], y: p[1], mode: 'auto' })),
  );
  s._contacts = () => true; // a contact change every round, for ever
  s.solve(30000);
  check(s.status === 'stalled', `status ${s.status}`);
});

test('frame budget: run() does not start an iteration it expects to overrun the budget', () => {
  const perf = Object.getOwnPropertyDescriptor(globalThis, 'performance');
  let t = 0;
  Object.defineProperty(globalThis, 'performance', {
    value: { now: () => t },
    configurable: true,
    writable: true,
  });
  try {
    for (const [cost, want] of [
      [5, 1],
      [3, 2],
      [1, 7],
    ]) {
      const s = new S.Strip({ d: 6, t: 3 });
      s.setPins(
        [
          [0, 0],
          [120, 60],
          [260, -30],
          [380, 40],
          [450, -20],
        ].map((p, i) => ({ id: i + 1, x: p[0], y: p[1], mode: 'auto' })),
      );
      const iterate = s._iterate.bind(s);
      s._iterate = () => {
        t += cost;
        return iterate();
      };
      const t0 = t;
      s.run(8);
      check(
        s.totalIter === want && t - t0 <= 8,
        `${cost} ms per iteration: ${s.totalIter} iterations in ${t - t0} ms (want ${want})`,
      );
    }
  } finally {
    Object.defineProperty(globalThis, 'performance', perf);
  }
});
