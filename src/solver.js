/*
 * Copyright (c) Jethro G. Beekman
 * 
 * This program is free software: you can redistribute it and/or modify it 
 * under the terms of the GNU General Public License as published by the Free 
 * Software Foundation, either version 3 of the License, or (at your option) 
 * any later version.
 *
 * This program is distributed in the hope that it will be useful, but WITHOUT 
 * ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or 
 * FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public License for 
 * more details.
 *
 * You should have received a copy of the GNU General Public License along with 
 * this program. If not, see <https://www.gnu.org/licenses/>. 
 *
 * =============================================================================
 * 
 * Spring-strip solver. No DOM access: runs in the browser and in Node.
 *
 * An inextensible elastic strip passes a sequence of round pins. Pins are
 * frictionless, the strip ends are free. The shape minimises ∫κ² ds subject to
 * the strip touching each engaged pin at distance r_eff from its centre,
 * tangentially (contact point Q = C − s·r_eff·n, n = left normal).
 *
 * Some layouts have no frictionless resting shape: the strip slides out
 * through the pins. The contact-to-contact length is therefore capped at
 * holdFactor × L_ref. While the cap is active the strip is "held": its
 * multiplier ν is the tension that friction at the end pins must supply. The
 * cap lets go as soon as the strip would rather be shorter, so the shape
 * depends only on the layout, never on how it was reached.
 *
 * Internally everything is divided by L_ref (sum of distances between
 * consecutive pins) and y is flipped to point up, so every tolerance below is
 * a pure number and "left" means left on screen.
 */
(function (root) {
  'use strict';

  const DEG = Math.PI / 180;
  const SEG_TARGET = 3 * DEG; // accuracy target: turn per segment
  const M_MIN = 8;
  const M_MAX = 64; // segments per stretch
  const REFINE_HI = 1.5;
  const REFINE_LO = 0.5;
  const TOL_STEP = 1e-9; // angle step (rad) and length step (relative, see _accept)
  const TOL_CON = 1e-9; // contact-point closure, in units of L_ref
  const MAX_DTHETA = 0.4; // rad per Newton step
  const H_SHRINK = 0.5;
  const H_GROW = 2; // stretch length limits per Newton step
  const HYST = 1e-3; // relative hysteresis for contact changes
  // Smallest meaningful contact force, in units of bending stiffness / L_ref²:
  // a straight strip's forces are rounding noise and must not count as pulling.
  const FORCE_FLOOR = 1e-6;
  const HOLD_PRESS_TOL = 0.02; // held length search: stop once the weakest contact pushes less than this (relative)
  const HOLD_SEARCH_MAX = 60; // held length search steps per user change
  const HOLD_PATIENCE = 4; // held length search: steps without progress before giving up
  const HOLD_TENSION_GROWTH = 8; // held length search: give up when the hold tension grows this much (strip pulled taut)
  const MU_INIT = 1e-3;
  const MU_MIN = 1e-12;
  const MU_MAX = 1e14;
  const MU_CONVERGED = 1e-3;
  const MAX_RETRIES = 4;
  const MAX_ITER_SETTLE = 3000; // per user change, then "stalled"
  const MAX_ROUNDS = 400; // contact/refine rounds per user change
  const MAX_FLIPS = 2; // auto flips per pin before "marginal"
  const MAX_ESCAPES = 3; // pushes off an unstable equilibrium per user change
  const ESCAPE_DTHETA = 0.05; // that push: at most this turn (rad) on any segment
  const ESCAPE_DH = 0.05; // and this relative change of any segment length
  const UNSTABLE_TOL = 1e-8; // negative curvature that counts, relative to the Hessian diagonal
  const LANCZOS_MAX = 12; // Lanczos steps when looking for the unstable direction (any negative Ritz value will do)

  // ---------------------------------------------------------------- banded LU
  // Entry (i,j) of an n×n matrix with lower bandwidth b is stored at
  // A[i*W + (j-i+b)], W = 3b+1, so U may grow to upper bandwidth 2b under
  // partial pivoting (row interchanges, LAPACK dgbtf2 style).
  // rowEnd tracks the last column each row can hold a nonzero in, so rows of
  // short stretches next to long ones are not swept over the full band.
  function bandLU(n, b, A, perm, rowEndIn) {
    const W = 3 * b + 1;
    const rowEnd = rowEndIn && rowEndIn.length >= n ? rowEndIn : new Int32Array(n);
    for (let i = 0; i < n; i++) {
      const ri = i * W - i + b;
      let j = Math.min(n - 1, i + b);
      while (j > i && A[ri + j] === 0) j--;
      rowEnd[i] = j;
    }
    for (let k = 0; k < n; k++) {
      const iMax = Math.min(n - 1, k + b);
      let p = k;
      let best = Math.abs(A[k * W + b]);
      for (let i = k + 1; i <= iMax; i++) {
        const v = Math.abs(A[i * W + (k - i + b)]);
        if (v > best) {
          best = v;
          p = i;
        }
      }
      perm[k] = p;
      if (!(best > 0) || !Number.isFinite(best)) return false;
      if (p !== k) {
        const rk = k * W - k + b;
        const rp = p * W - p + b;
        const jMax = Math.max(rowEnd[k], rowEnd[p]);
        for (let j = k; j <= jMax; j++) {
          const t = A[rk + j];
          A[rk + j] = A[rp + j];
          A[rp + j] = t;
        }
        const t = rowEnd[k];
        rowEnd[k] = rowEnd[p];
        rowEnd[p] = t;
      }
      const rk = k * W - k + b;
      const jMax = rowEnd[k];
      const piv = A[rk + k];
      for (let i = k + 1; i <= iMax; i++) {
        const ri = i * W - i + b;
        const aik = A[ri + k];
        if (aik === 0) continue;
        const l = aik / piv;
        A[ri + k] = l;
        for (let j = k + 1; j <= jMax; j++) A[ri + j] -= l * A[rk + j];
        if (jMax > rowEnd[i]) rowEnd[i] = jMax;
      }
    }
    return true;
  }

  function bandSolve(n, b, A, perm, x) {
    const W = 3 * b + 1;
    for (let k = 0; k < n; k++) {
      const p = perm[k];
      if (p !== k) {
        const t = x[k];
        x[k] = x[p];
        x[p] = t;
      }
      const xk = x[k];
      if (xk !== 0) {
        const iMax = Math.min(n - 1, k + b);
        for (let i = k + 1; i <= iMax; i++) x[i] -= A[i * W + (k - i + b)] * xk;
      }
    }
    for (let i = n - 1; i >= 0; i--) {
      const ri = i * W - i + b;
      const jMax = Math.min(n - 1, i + 2 * b);
      let s = x[i];
      for (let j = i + 1; j <= jMax; j++) s -= A[ri + j] * x[j];
      x[i] = s / A[ri + i];
    }
  }

  // Work done since the page (or test) started, for tests and measurements:
  // Newton iterations of every strip, fresh candidates included, and searches
  // that found an unstable direction, with the slowest one's time.
  const work = { iterations: 0, searches: 0, slowestSearchMs: 0 };

  // Statuses with nothing left to run until the next user change.
  const IDLE = new Set(['converged', 'friction', 'failed', 'stalled', 'empty', 'invalid']);
  // milliseconds (performance is looked up on each call, so tests can replace it)
  function now() {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
  }

  // The largest contact force, at least FORCE_FLOOR.
  function maxForce(F) {
    let m = FORCE_FLOOR;
    for (const f of F) m = Math.max(m, Math.hypot(f[0], f[1]));
    return m;
  }
  // How hard force f pushes a pin on side `side` against the strip, whose
  // tangent there is phi (> 0: it pushes, < 0: it pulls).
  function pressOf(f, phi, side) {
    return -side * (f[0] * -Math.sin(phi) + f[1] * Math.cos(phi));
  }

  function dot(u, v) {
    let s = 0;
    for (let i = 0; i < u.length; i++) s += u[i] * v[i];
    return s;
  }

  // 1 for the multiplier unknowns (λx, λy of each stretch), 0 for angles and lengths.
  function dualMask(L) {
    const dual = new Uint8Array(L.n);
    for (let k = 0; k < L.K; k++) {
      const ih = iH(L, k);
      dual[ih + 1] = 1;
      dual[ih + 2] = 1;
    }
    return dual;
  }

  // A fixed pseudo-random vector on the angles and lengths, the same on every run.
  function startVector(dual) {
    let seed = 1;
    const v = new Float64Array(dual.length);
    for (let i = 0; i < v.length; i++) {
      if (!dual[i]) {
        seed = (seed * 16807) % 2147483647;
        v[i] = seed / 2147483647 - 0.5;
      }
    }
    return v;
  }

  // Make w orthogonal to the vectors in Q (twice, for rounding).
  function reorthogonalise(w, Q) {
    for (let pass = 0; pass < 2; pass++) {
      for (const qu of Q) {
        const c = dot(qu, w);
        for (let i = 0; i < w.length; i++) w[i] -= c * qu[i];
      }
    }
  }

  // Lanczos with full reorthogonalisation on the symmetric operator op, from v0.
  // Returns the most negative Ritz value and its vector, or null if none is negative.
  function lowestRitz(op, v0, steps) {
    let q = op(v0);
    const q0 = Math.sqrt(dot(q, q));
    if (!(q0 > 0) || !Number.isFinite(q0)) return null;
    q = q.map((v) => v / q0);
    const Q = [];
    const al = [];
    const be = [];
    const w = new Float64Array(v0.length);
    for (let j = 0; j < steps; j++) {
      Q.push(q);
      op(q, w);
      al.push(dot(q, w));
      reorthogonalise(w, Q);
      const bn = Math.sqrt(dot(w, w));
      if (!(bn > 1e-10 * Math.abs(al[j]))) break;
      be.push(bn);
      q = w.map((v) => v / bn);
    }
    const { values, vectors } = symEig(tridiagonal(al, be));
    let imin = 0;
    for (let i = 1; i < values.length; i++) if (values[i] < values[imin]) imin = i;
    if (!(values[imin] < 0)) return null;
    const y = new Float64Array(v0.length);
    for (let i = 0; i < Q.length; i++) {
      const c = vectors[i][imin];
      for (let t = 0; t < y.length; t++) y[t] += c * Q[i][t];
    }
    return { value: values[imin], vector: y };
  }

  // The symmetric tridiagonal matrix with diagonal al and off-diagonal be.
  function tridiagonal(al, be) {
    const k = al.length;
    return Array.from({ length: k }, (_, i) => {
      const r = new Float64Array(k);
      r[i] = al[i];
      if (i > 0) r[i - 1] = be[i - 1];
      if (i + 1 < k) r[i + 1] = be[i];
      return r;
    });
  }

  // steps of (shifted) inverse iteration y ← op(y)/|op(y)|; null if it breaks down.
  function inverseIteration(op, y0, steps) {
    let y = y0;
    for (let it = 0; it < steps; it++) {
      y = op(y);
      const yn = Math.sqrt(dot(y, y));
      if (!(yn > 0) || !Number.isFinite(yn)) return null;
      for (let i = 0; i < y.length; i++) y[i] /= yn;
    }
    return y;
  }

  // A·v for a band matrix as assembled (before factorising: bandwidth b both ways).
  function bandMul(n, b, A, v) {
    const W = 3 * b + 1;
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let j = Math.max(0, i - b), jm = Math.min(n - 1, i + b); j <= jm; j++) {
        s += A[i * W + (j - i + b)] * v[j];
      }
      out[i] = s;
    }
    return out;
  }

  // Eigenvalues and eigenvectors (columns of vectors) of a small symmetric
  // matrix, by Jacobi rotations.
  function symEig(A0) {
    const k = A0.length;
    const A = A0.map((r) => Float64Array.from(r));
    const V = Array.from({ length: k }, (_, i) => {
      const r = new Float64Array(k);
      r[i] = 1;
      return r;
    });
    for (let sweep = 0; sweep < 50; sweep++) {
      let off = 0;
      let tot = 0;
      for (let i = 0; i < k; i++) {
        for (let j = 0; j < k; j++) {
          const v = A[i][j] * A[i][j];
          tot += v;
          if (i !== j) off += v;
        }
      }
      if (!(off > 1e-28 * tot)) break;
      for (let p = 0; p < k; p++) {
        for (let q = p + 1; q < k; q++) {
          const apq = A[p][q];
          if (apq === 0) continue;
          const th = (A[q][q] - A[p][p]) / (2 * apq);
          const t = (th >= 0 ? 1 : -1) / (Math.abs(th) + Math.sqrt(th * th + 1));
          const c = 1 / Math.sqrt(t * t + 1);
          const s = t * c;
          for (let r = 0; r < k; r++) {
            const a = A[r][p];
            const e = A[r][q];
            A[r][p] = c * a - s * e;
            A[r][q] = s * a + c * e;
          }
          for (let r = 0; r < k; r++) {
            const a = A[p][r];
            const e = A[q][r];
            A[p][r] = c * a - s * e;
            A[q][r] = s * a + c * e;
          }
          for (let r = 0; r < k; r++) {
            const a = V[r][p];
            const e = V[r][q];
            V[r][p] = c * a - s * e;
            V[r][q] = s * a + c * e;
          }
        }
      }
    }
    return { values: A.map((r, i) => r[i]), vectors: V };
  }

  // ------------------------------------------------------------ discretisation
  // Unknowns are stored stretch by stretch: θ_k,0..a-1, h_k, λx_k, λy_k,
  // θ_k,a..m-1 with a = floor(m/2). Keeping h and λ mid-block keeps the
  // couplings inside a stretch within about m/2 of the diagonal, but the bending
  // term at a pin, 2D²/(h_k-1 + h_k), couples neighbouring h's, so the band is
  // about (m_k-1 + m_k)/2 + 3.
  function makeLayout(m) {
    const K = m.length;
    const base = new Int32Array(K);
    const a = new Int32Array(K);
    let n = 0;
    for (let k = 0; k < K; k++) {
      base[k] = n;
      a[k] = m[k] >> 1;
      n += m[k] + 3;
    }
    return { K, m: Int32Array.from(m), base, a, n };
  }
  function iTh(L, k, j) {
    return L.base[k] + j + (j < L.a[k] ? 0 : 3);
  }
  function iH(L, k) {
    return L.base[k] + L.a[k];
  }

  // Node tangent at engaged pin i: weights over θ indices.
  function nodeWeights(L, i) {
    const K = L.K;
    if (i === 0) return [[iTh(L, 0, 0), 1]];
    if (i === K) return [[iTh(L, K - 1, L.m[K - 1] - 1), 1]];
    return [
      [iTh(L, i - 1, L.m[i - 1] - 1), 0.5],
      [iTh(L, i, 0), 0.5],
    ];
  }

  // Evaluate the Lagrangian. P: {L, C (Float64Array 2(K+1)), s (Int8Array), r, tau}.
  // tau is the hold multiplier ν (a uniform tension), 0 when the length is free.
  // addS(i,j,v) accumulates symmetric Hessian entries (or null).
  // Returns {E, len, con (max |c_k|), conSum (Σ|c_k|), lamMax, phi, Q}. Fills g if given.
  // The terms are added to one accumulator, ev, always in the same order.
  function evaluate(P, x, g, addS) {
    const K = P.L.K;
    if (g) g.fill(0);
    const ev = { P, x, g, addS, E: 0, len: 0, conMax: 0, conSum: 0 };
    const { phi, Q, W } = contactPoints(P, x);
    for (let k = 0; k < K; k++) stretchTerms(ev, k, Q);
    for (let i = 0; i <= K; i++) contactTerms(ev, i, phi[i], W[i]);
    return {
      E: ev.E,
      len: ev.len,
      con: ev.conMax,
      conSum: ev.conSum,
      lamMax: maxMultiplier(P.L, x),
      phi,
      Q,
    };
  }

  // Node tangent φ_i and contact point Q_i = C_i − s_i·r·n(φ_i) at each engaged pin,
  // and the weights giving φ_i from the angles.
  function contactPoints(P, x) {
    const { L, C, s, r } = P;
    const K = L.K;
    const phi = new Float64Array(K + 1);
    const Q = new Float64Array(2 * (K + 1));
    const W = [];
    for (let i = 0; i <= K; i++) {
      const w = nodeWeights(L, i);
      W.push(w);
      let f = 0;
      for (const [idx, wt] of w) f += wt * x[idx];
      phi[i] = f;
      Q[2 * i] = C[2 * i] + s[i] * r * Math.sin(f);
      Q[2 * i + 1] = C[2 * i + 1] - s[i] * r * Math.cos(f);
    }
    return { phi, Q, W };
  }

  // Bending energy c·D²/S between neighbouring segment angles iA and iB, with
  // its gradient and Hessian. Within a stretch S = h1 and c = 1 (h2 < 0); at a
  // pin S = h1 + h2, the two stretches' segment lengths, and c = 2.
  function joint(ev, iA, iB, h1, h2) {
    const { x, g, addS } = ev;
    const c = h2 < 0 ? 1 : 2;
    const D = x[iB] - x[iA];
    const S = h2 < 0 ? x[h1] : x[h1] + x[h2];
    ev.E += (c * D * D) / S;
    if (g) {
      const gd = (2 * c * D) / S;
      const gh = (-c * D * D) / (S * S);
      g[iB] += gd;
      g[iA] -= gd;
      g[h1] += gh;
      if (h2 >= 0) g[h2] += gh;
    }
    if (!addS) return;
    const k2 = (2 * c) / S;
    const kdh = (2 * c * D) / (S * S);
    const khh = (2 * c * D * D) / (S * S * S);
    addS(iA, iA, k2);
    addS(iB, iB, k2);
    addS(iA, iB, -k2);
    addS(iB, h1, -kdh);
    addS(iA, h1, kdh);
    addS(h1, h1, khh);
    if (h2 >= 0) {
      addS(iB, h2, -kdh);
      addS(iA, h2, kdh);
      addS(h2, h2, khh);
      addS(h1, h2, khh);
    }
  }

  // Stretch k: bending within it and at the pin before it, its length (with the
  // hold tension), and its closure constraint.
  function stretchTerms(ev, k, Q) {
    const { P, x, g } = ev;
    const L = P.L;
    const m = L.m[k];
    const ih = iH(L, k);
    for (let j = 1; j < m; j++) joint(ev, iTh(L, k, j - 1), iTh(L, k, j), ih, -1);
    if (k > 0) joint(ev, iTh(L, k - 1, L.m[k - 1] - 1), iTh(L, k, 0), iH(L, k - 1), ih);
    ev.len += m * x[ih];
    if (g) g[ih] += P.tau * m;
    closure(ev, k, Q);
  }

  // The closure constraint c_k = h Σ u(θ) − Q_{k+1} + Q_k with multiplier λ_k.
  function closure(ev, k, Q) {
    const { P, x, g, addS } = ev;
    const L = P.L;
    const m = L.m[k];
    const ih = iH(L, k);
    const lx = ih + 1;
    const ly = ih + 2;
    const h = x[ih];
    const lamx = x[lx];
    const lamy = x[ly];
    let Sx = 0;
    let Sy = 0;
    for (let j = 0; j < m; j++) {
      const it = iTh(L, k, j);
      const th = x[it];
      const ct = Math.cos(th);
      const st = Math.sin(th);
      Sx += ct;
      Sy += st;
      if (g) g[it] += h * (-lamx * st + lamy * ct);
      if (addS) {
        addS(it, it, h * (-lamx * ct - lamy * st));
        addS(it, ih, -lamx * st + lamy * ct);
        addS(it, lx, -h * st);
        addS(it, ly, h * ct);
      }
    }
    const cx = h * Sx - Q[2 * k + 2] + Q[2 * k];
    const cy = h * Sy - Q[2 * k + 3] + Q[2 * k + 1];
    if (g) {
      g[ih] += lamx * Sx + lamy * Sy;
      g[lx] = cx;
      g[ly] = cy;
    }
    if (addS) {
      addS(ih, lx, Sx);
      addS(ih, ly, Sy);
    }
    const cn = Math.hypot(cx, cy);
    ev.conSum += cn;
    if (cn > ev.conMax) ev.conMax = cn;
  }

  // Contact point i: G_i·Q_i(φ_i) with G_i = λ_i − λ_{i−1}.
  function contactTerms(ev, i, f, w) {
    const { P, x, g, addS } = ev;
    const L = P.L;
    const K = L.K;
    const sr = P.s[i] * P.r;
    const dQx = sr * Math.cos(f);
    const dQy = sr * Math.sin(f); // Q'
    const ddQx = -sr * Math.sin(f);
    const ddQy = sr * Math.cos(f); // Q''
    // the multipliers of the stretches after (+) and before (−) the contact
    const sides = [];
    if (i < K) sides.push([iH(L, i), 1]);
    if (i > 0) sides.push([iH(L, i - 1), -1]);
    let Gx = 0;
    let Gy = 0;
    for (const [ih, sg] of sides) {
      Gx += sg * x[ih + 1];
      Gy += sg * x[ih + 2];
    }
    if (g) for (const [idx, wt] of w) g[idx] += wt * (Gx * dQx + Gy * dQy);
    if (!addS) return;
    const curv = Gx * ddQx + Gy * ddQy;
    for (let p = 0; p < w.length; p++) {
      for (let q = p; q < w.length; q++) addS(w[p][0], w[q][0], w[p][1] * w[q][1] * curv);
      const [idx, wt] = w[p];
      for (const [ih, sg] of sides) {
        addS(idx, ih + 1, sg * wt * dQx);
        addS(idx, ih + 2, sg * wt * dQy);
      }
    }
  }

  function maxMultiplier(L, x) {
    let lamMax = 0;
    for (let k = 0; k < L.K; k++) {
      const ih = iH(L, k);
      lamMax = Math.max(lamMax, Math.hypot(x[ih + 1], x[ih + 2]));
    }
    return lamMax;
  }

  // Initial unknowns from the stretch guesses: segment angles (unwrapped along
  // the whole strip), segment lengths and internal forces.
  function initialUnknowns(L, C, guesses) {
    const x = new Float64Array(L.n);
    let prevAng = null;
    for (let k = 0; k < L.K; k++) {
      const { sp, lam } = guesses[k];
      const m = L.m[k];
      let tot = 0;
      const fallback = Math.atan2(C[2 * k + 3] - C[2 * k + 1], C[2 * k + 2] - C[2 * k]);
      for (let j = 0; j < m; j++) {
        const dx = sp[j + 1][0] - sp[j][0];
        const dy = sp[j + 1][1] - sp[j][1];
        const l = Math.hypot(dx, dy);
        tot += l;
        const keep = prevAng === null ? fallback : prevAng; // a zero-length segment keeps the direction
        let a = l > 0 ? Math.atan2(dy, dx) : keep;
        if (prevAng !== null) a = prevAng + wrapPi(a - prevAng);
        x[iTh(L, k, j)] = a;
        prevAng = a;
      }
      const ih = iH(L, k);
      x[ih] = Math.max(tot / m, 1e-9);
      x[ih + 1] = lam[0];
      x[ih + 2] = lam[1];
    }
    return x;
  }

  function bandwidthOf(P, x) {
    let b = 1;
    evaluate(P, x, null, (i, j) => {
      const d = Math.abs(i - j);
      if (d > b) b = d;
    });
    return b;
  }

  // -------------------------------------------------------------- geometry
  function cumLen(pts) {
    const c = new Float64Array(pts.length);
    for (let i = 1; i < pts.length; i++) {
      c[i] = c[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    }
    return c;
  }
  function segIndexAt(cum, t) {
    let lo = 0;
    let hi = cum.length - 1;
    if (t <= cum[0]) return 0;
    if (t >= cum[hi]) return Math.max(0, hi - 1);
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] <= t) lo = mid;
      else hi = mid;
    }
    return lo;
  }
  function pointAt(pts, cum, t) {
    const i = segIndexAt(cum, t);
    const l = cum[i + 1] - cum[i];
    const u = l > 0 ? Math.min(1, Math.max(0, (t - cum[i]) / l)) : 0;
    return [
      pts[i][0] + u * (pts[i + 1][0] - pts[i][0]),
      pts[i][1] + u * (pts[i + 1][1] - pts[i][1]),
    ];
  }
  function dirAt(pts, cum, t) {
    const i = segIndexAt(cum, t);
    let dx = pts[i + 1][0] - pts[i][0];
    let dy = pts[i + 1][1] - pts[i][1];
    // at a vertex, average the two neighbouring directions
    const eps = 1e-12 * (cum[cum.length - 1] || 1);
    if (Math.abs(t - cum[i]) <= eps && i > 0) {
      const l1 = Math.hypot(dx, dy);
      const px = pts[i][0] - pts[i - 1][0];
      const py = pts[i][1] - pts[i - 1][1];
      const l0 = Math.hypot(px, py);
      if (l0 > 0 && l1 > 0) {
        dx = dx / l1 + px / l0;
        dy = dy / l1 + py / l0;
      }
    } else if (Math.abs(t - cum[i + 1]) <= eps && i + 2 < pts.length) {
      const l1 = Math.hypot(dx, dy);
      const nx = pts[i + 2][0] - pts[i + 1][0];
      const ny = pts[i + 2][1] - pts[i + 1][1];
      const l2 = Math.hypot(nx, ny);
      if (l2 > 0 && l1 > 0) {
        dx = dx / l1 + nx / l2;
        dy = dy / l1 + ny / l2;
      }
    }
    const l = Math.hypot(dx, dy);
    return l > 0 ? [dx / l, dy / l] : [1, 0];
  }
  // Closest point on the polyline to [px, py], with parameter in [t0, t1].
  function project(pts, cum, [px, py], t0, t1) {
    let best = Infinity;
    let bt = Math.max(t0, cum[0]);
    const i0 = segIndexAt(cum, Math.max(t0, cum[0]));
    const i1 = segIndexAt(cum, Math.min(t1, cum[cum.length - 1]));
    for (let i = i0; i <= i1; i++) {
      const ax = pts[i][0];
      const ay = pts[i][1];
      const dx = pts[i + 1][0] - ax;
      const dy = pts[i + 1][1] - ay;
      const l2 = dx * dx + dy * dy;
      const u = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
      let t = cum[i] + u * (cum[i + 1] - cum[i]);
      t = Math.min(Math.max(t, t0, cum[i]), t1, cum[i + 1]);
      const q = pointAt(pts, cum, t);
      const d = Math.hypot(px - q[0], py - q[1]);
      if (d < best) {
        best = d;
        bt = t;
      }
    }
    return { t: bt, d: best };
  }
  function turnOf(pts, cum, t0, t1) {
    const i0 = segIndexAt(cum, t0);
    const i1 = segIndexAt(cum, t1);
    let turn = 0;
    let prev = null;
    for (let i = i0; i <= i1; i++) {
      const dx = pts[i + 1][0] - pts[i][0];
      const dy = pts[i + 1][1] - pts[i][1];
      if (dx === 0 && dy === 0) continue;
      const a = Math.atan2(dy, dx);
      if (prev !== null) turn += Math.abs(wrapPi(a - prev));
      prev = a;
    }
    return turn;
  }
  function wrapPi(a) {
    return a - 2 * Math.PI * Math.round(a / (2 * Math.PI));
  }
  function clampM(m) {
    return Math.min(M_MAX, Math.max(M_MIN, m));
  }
  function segsForTurn(turn) {
    return clampM(Math.ceil(turn / SEG_TARGET - 1e-9));
  }
  function cross(ax, ay, bx, by) {
    return ax * by - ay * bx;
  }
  function sgn(v) {
    return v < 0 ? -1 : 1;
  }
  // Pin modes: 'auto' (touches, side chosen by the contact force), 'left' and
  // 'right' (one-sided: touches only when pressed against), 'through' (the
  // centreline passes through the pin centre: never lets go, slides freely).
  // The side a pin touches: fixed for Through (none), Left and Right, else as given.
  function modeSide(mode, side) {
    if (mode === 'through') return 0;
    if (mode === 'left') return 1;
    if (mode === 'right') return -1;
    return side || 1;
  }
  function sided(p) {
    return p.mode === 'left' || p.mode === 'right';
  }

  // Neighbouring pins at the same position (within tol) act as one pin, the
  // first of them: a stretch between them would have no length. They can share
  // a contact when all are Through, or none is and they are not both Left and
  // Right; the one pin then has that shared mode. Pins that cannot share a
  // contact are kept apart and reported in invalid.
  // Returns {pins, leadOf (id -> id of the pin it acts as), invalid: [{a, b, why}]}.
  function groupPins(list, tol) {
    const pins = [];
    const leadOf = new Map();
    const invalid = [];
    for (let i = 0; i < list.length;) {
      const q = list[i];
      let j = i + 1;
      while (j < list.length && Math.hypot(list[j].x - q.x, list[j].y - q.y) <= tol) j++;
      const run = list.slice(i, j);
      const modes = run.map((p) => p.mode || 'auto');
      i = j;
      if (run.length === 1) {
        pins.push(q);
        continue;
      }
      const iThrough = modes.indexOf('through');
      const iOther = modes.findIndex((m) => m !== 'through');
      const iLeft = modes.indexOf('left');
      const iRight = modes.indexOf('right');
      let conflict = null;
      if (iThrough >= 0 && iOther >= 0) conflict = [iThrough, iOther, 'through'];
      else if (iLeft >= 0 && iRight >= 0) conflict = [iLeft, iRight, 'sides'];
      if (conflict) {
        const [u, v, why] = conflict;
        invalid.push({ a: run[Math.min(u, v)].id, b: run[Math.max(u, v)].id, why });
        for (const p of run) pins.push(p);
        continue;
      }
      let mode = 'auto';
      if (iThrough >= 0) mode = 'through';
      else if (iLeft >= 0) mode = 'left';
      else if (iRight >= 0) mode = 'right';
      pins.push(Object.assign({}, q, { mode }));
      for (const p of run.slice(1)) leadOf.set(p.id, q.id);
    }
    return { pins, leadOf, invalid };
  }

  // ------------------------------------------------------------------ data
  /**
   * A pin as given, in sequence order: mm, y down. side and engaged are only
   * read for pins the solver has not seen (restoring a saved state).
   * @typedef {object} PinInput
   * @property {number} id
   * @property {number} x
   * @property {number} y
   * @property {'auto'|'left'|'right'|'through'} [mode]
   * @property {-1|0|1} [side]  1 left, -1 right, 0 Through
   * @property {boolean} [engaged]
   */
  /**
   * The discretised problem for one set of engaged pins, in normalised units
   * (lengths ÷ L_ref, y up). Built by _makeProblem with every field it has.
   * @typedef {object} Problem
   * @property {{K: number, m: Int32Array, base: Int32Array, a: Int32Array, n: number}} L  unknowns per stretch (makeLayout)
   * @property {Float64Array} C  engaged pin centres, x, y pairs
   * @property {Int8Array} s  the sides they touch
   * @property {number} r  contact offset r_eff
   * @property {number} tau  the hold multiplier ν while held, else 0
   * @property {number} cap  the length limit
   * @property {{Lref: number, ox: number, oy: number}} N  the normalisation
   * @property {number[]} eng  indices of the engaged pins in Strip.pins
   * @property {number[]} engIds  their ids
   * @property {string} sig  the layout it was built for (Strip._signature)
   * @property {boolean} noHold  the contact geometry alone fixes the length
   * @property {number} b  bandwidth (W = 3b + 1 entries per stored row)
   * @property {number} W
   * @property {number} bz  bᵀK⁻¹b for the bordered length row
   * @property {Float64Array} A  the Hessian, band storage; Aw its damped factorisation
   * @property {Float64Array} Aw
   */
  /**
   * One pin in result(): mm, y down.
   * @typedef {object} PinResult
   * @property {number} id
   * @property {string} mode
   * @property {number} side
   * @property {boolean} engaged
   * @property {string} [label]  'inside' | 'outside' | 'straight' | 'through' | 'free'
   * @property {number[]} [contact]  where the strip touches it
   * @property {number} [force]  its load, relative to the largest (0–1)
   * @property {number[]} [forceVec]
   * @property {number} [press]  > 0 when it pushes on the strip
   * @property {number} [muReq]  friction needed, at the ends of a held strip
   * @property {string[]} warnings  'wrap' | 'liftoff' | 'marginal' | 'duplicate' | 'overlap'
   * @property {number[]} [sameAs]  pins at the same position (they act as one)
   * @property {number[]} [overlaps]  pins closer than the pin diameter
   */
  /**
   * The shape and its readouts: mm, y down.
   * @typedef {object} Result
   * @property {string} status  'empty' | 'converging' | 'converged' | 'friction' (held) | 'failed' | 'stalled' | 'invalid'
   * @property {boolean} held  the length is held at a limit (it would slide out)
   * @property {boolean} heldBelowLimit
   * @property {number} muReq  the friction the end pins need, when held
   * @property {number[][]} nodes  the centreline
   * @property {number[]} tangents  at the nodes, radians
   * @property {number[]} curvature  at the nodes, 1/mm, positive turning left on screen
   * @property {number} length  between the end contacts
   * @property {number} minRadius
   * @property {?number[]} minRadiusAt
   * @property {boolean} stale  the shape was solved for an earlier layout
   * @property {boolean} unstable  an unstable equilibrium that could not be left
   * @property {{a: number, b: number, why: string}[]} invalid  pins at one position that cannot share a contact
   * @property {PinResult[]} pins  one per pin as given
   */
  /**
   * Enough to rebuild the same shape (getState, setState).
   * @typedef {object} State
   * @property {PinInput[]} pins
   * @property {?{nodes: number[][], params: Array, stretches: Array}} shape  a starting point, or null
   * @property {{d?: number, t?: number, holdFactor?: number}} [settings]  for setState
   */

  // ------------------------------------------------------------------ Strip
  class Strip {
    constructor(settings) {
      this.settings = { d: 6, t: 3, holdFactor: 2 };
      this.userPins = []; // the pins as given: [{id,x,y,mode}]
      this.leadOf = new Map(); // id of a pin at the same position as the one before it -> that pin's id
      this.invalid = []; // [{a, b, why}]: pins at the same position that cannot share a contact
      this.posTol = 0; // distance (mm) below which pins count as at the same position
      this.pins = []; // [{id,x,y,mode,side,engaged,flips,marginal,events}], one per position
      this.prob = null; // current discretised problem
      this.x = null;
      this.mu = MU_INIT;
      this.status = 'empty';
      this.iter = 0; // Newton iterations since last user change
      this.rounds = 0;
      this.totalIter = 0;
      this.lastGood = null;
      this.hold = false;
      this.nu = 0; // hold multiplier, normalised
      this.capN = null; // held length below the limit, normalised (null: at the limit)
      this.cs = null; // held length search state
      this.escapes = 0; // pushes off unstable equilibria since the last user change
      this.unstable = false; // the shape is an unstable equilibrium that could not be left
      this.iterMs = 0; // running estimate of one Newton iteration's time
      this.resume = false; // the next run() carries on after a converged iteration
      if (settings) this.setSettings(settings);
    }

    setSettings(st) {
      const shape = this.prob ? this.shape() : null;
      Object.assign(this.settings, st);
      this._userChange();
      this._rebuild(shape);
      this._markStart();
    }

    get rEff() {
      return this.settings.d / 2 + this.settings.t / 2;
    }

    // Keep the pins as given and return the ones the strip sees: one per run of
    // neighbouring pins at the same position.
    _group(list) {
      for (const q of list) {
        if (
          typeof q.x !== 'number' ||
          typeof q.y !== 'number' ||
          !Number.isFinite(q.x) ||
          !Number.isFinite(q.y)
        ) {
          throw new Error(`pin ${q.id}: coordinates must be finite numbers`);
        }
      }
      let len = 0;
      for (let i = 1; i < list.length; i++) {
        len += Math.hypot(list[i].x - list[i - 1].x, list[i].y - list[i - 1].y);
      }
      // rounding noise (an imported coordinate list, say) still counts as the same position
      this.posTol = 1e-6 * Math.max(len, this.rEff);
      const g = groupPins(list, this.posTol);
      this.userPins = list.map((q) => ({ id: q.id, x: q.x, y: q.y, mode: q.mode || 'auto' }));
      this.leadOf = g.leadOf;
      this.invalid = g.invalid;
      return g.pins;
    }
    // The id of the pin that a given pin acts as (itself, or the pin before it at the same position).
    _lead(id) {
      return this.leadOf.has(id) ? this.leadOf.get(id) : id;
    }

    /** @param {PinInput[]} list  the pins in sequence order */
    setPins(list) {
      const old = new Map(this.pins.map((p) => [p.id, p]));
      const shape = this.prob ? this.shape() : null;
      const isNew = [];
      const pins = this._group(list).map((q) => {
        const o = old.get(q.id);
        const p = o
          ? Object.assign({}, o)
          : { id: q.id, side: 1, engaged: true, flips: 0, marginal: false, events: 0, fresh: true };
        if (!o && q.side) {
          p.side = q.side;
          p.fresh = false;
        }
        if (!o && q.engaged === false) p.engaged = false;
        if (o && o.mode !== q.mode) p.engaged = true;
        p.x = q.x;
        p.y = q.y;
        p.mode = q.mode || 'auto';
        // fixed for Left, Right and Through; an Auto pin that was Through gets a side
        p.side = modeSide(p.mode, p.side);
        if (p.mode === 'through') p.engaged = true;
        isNew.push(!o);
        return p;
      });
      this.pins = pins;
      this._userChange();
      this._rebuild(shape, isNew);
      this._markStart();
    }

    // A new solve: its counters, damping, fresh re-solve, held length search and
    // escapes. The held length is searched afresh, from the limit: a length held
    // for an earlier layout (before an edit, an undo or opening a file) no longer applies.
    _resetProgress() {
      this.capN = null;
      this.iter = 0;
      this.rounds = 0;
      this.mu = MU_INIT;
      this.cand = null;
      this.candDone = false;
      this.candKind = null;
      this.cs = null;
      this.escapes = 0;
      this.unstable = false;
      this.resume = false;
    }

    _userChange() {
      this._resetProgress();
      for (const p of this.pins) {
        p.flips = 0;
        p.events = 0;
        p.marginal = false;
        p.holdTried = false;
      }
      if (this.pins.length >= 2) this.status = 'converging';
    }

    // ----------------------------------------------------------- normalisation
    _norm() {
      const pins = this.pins;
      let Lref = 0;
      for (let i = 1; i < pins.length; i++) {
        Lref += Math.hypot(pins[i].x - pins[i - 1].x, pins[i].y - pins[i - 1].y);
      }
      let ox = 0;
      let oy = 0;
      for (const p of pins) {
        ox += p.x;
        oy += p.y;
      }
      ox /= pins.length || 1;
      oy /= pins.length || 1;
      if (!(Lref > 0)) Lref = Math.max(this.rEff * 4, 1e-9);
      return { Lref, ox, oy };
    }
    toN(N, x, y) {
      return [(x - N.ox) / N.Lref, -(y - N.oy) / N.Lref];
    }
    fromN(N, x, y) {
      return [N.ox + x * N.Lref, N.oy - y * N.Lref];
    }

    // ------------------------------------------------------- shape (mm, y down)
    // Current centreline as nodes, with a parameter (arc length, mm) for every
    // pin that lies along it and the internal force of each stretch.
    shape() {
      const P = this.prob;
      const x = this.x;
      if (!P) return null;
      const { nodes, nodeOfPin } = this._nodesN();
      const N = P.N;
      const ptsMM = nodes.map((p) => this.fromN(N, p[0], p[1]));
      const cum = cumLen(ptsMM);
      const params = new Map();
      P.engIds.forEach((id, i) => params.set(id, cum[nodeOfPin[i]]));
      // released pins: project between their engaged neighbours
      const idIndex = new Map(this.pins.map((p, i) => [p.id, i]));
      const engIdx = P.engIds.map((id) => idIndex.get(id));
      for (let i = 0; i < this.pins.length; i++) {
        const p = this.pins[i];
        if (params.has(p.id)) continue;
        let lo = 0;
        let hi = cum[cum.length - 1];
        for (let e = 0; e < engIdx.length; e++) {
          if (engIdx[e] !== undefined && engIdx[e] < i) lo = params.get(P.engIds[e]);
          if (engIdx[e] !== undefined && engIdx[e] > i) {
            hi = params.get(P.engIds[e]);
            break;
          }
        }
        if (engIdx[0] !== undefined && i < engIdx[0]) continue;
        if (engIdx[engIdx.length - 1] !== undefined && i > engIdx[engIdx.length - 1]) continue;
        params.set(p.id, project(ptsMM, cum, [p.x, p.y], lo, hi).t);
      }
      const stretches = [];
      for (let k = 0; k < P.L.K; k++) {
        const ih = iH(P.L, k);
        const sc = 1 / (N.Lref * N.Lref);
        stretches.push({
          a: P.engIds[k],
          b: P.engIds[k + 1],
          m: P.L.m[k],
          t0: cum[nodeOfPin[k]],
          t1: cum[nodeOfPin[k + 1]],
          lam: [x[ih + 1] * sc, -x[ih + 2] * sc],
        });
      }
      return { nodes: ptsMM, cum, params, stretches };
    }

    // Node positions in normalised units. Each stretch starts at its contact
    // point; any closure error is spread linearly so the drawing is continuous.
    _nodesN() {
      const P = this.prob;
      const x = this.x;
      const L = P.L;
      const ev = evaluate(P, x, null, null);
      const Q = ev.Q;
      const nodes = [];
      const nodeOfPin = [0];
      nodes.push([Q[0], Q[1]]);
      for (let k = 0; k < L.K; k++) {
        const m = L.m[k];
        const h = x[iH(L, k)];
        let px = Q[2 * k];
        let py = Q[2 * k + 1];
        const raw = [];
        for (let j = 0; j < m; j++) {
          const th = x[iTh(L, k, j)];
          px += h * Math.cos(th);
          py += h * Math.sin(th);
          raw.push([px, py]);
        }
        const ex = Q[2 * k + 2] - px;
        const ey = Q[2 * k + 3] - py;
        for (let j = 0; j < m; j++) {
          const u = (j + 1) / m;
          nodes.push([raw[j][0] + u * ex, raw[j][1] + u * ey]);
        }
        nodeOfPin.push(nodes.length - 1);
      }
      return { nodes, nodeOfPin, ev };
    }

    // ------------------------------------------------------------- rebuilding
    // Build stretches for the current engaged pins from an old centreline.
    // mOverride: Map "idA|idB" -> m (refinement).
    _rebuild(shape, isNew, mOverride) {
      const pins = this.pins;
      // pins at the same position that cannot share a contact: nothing to solve
      // (the last shape stays, marked stale, as a starting point for the next edit)
      if (this.invalid.length) {
        this.status = 'invalid';
        return;
      }
      if (pins.length < 2) {
        this.prob = null;
        this.x = null;
        this.status = 'empty';
        return;
      }
      pins[0].engaged = true;
      pins[pins.length - 1].engaged = true;
      const N = this._norm();
      const line = this._startLine(shape, N);
      this._placeNewPins(line, isNew, N);
      for (const p of pins) {
        p.fresh = false;
        if (p.mode === 'auto' && !p.side) p.side = 1;
      }
      const con = this._engagedContacts(line, N);
      const guesses = [];
      const ctx = { shape, line, con, mOverride, N };
      for (let k = 0; k < con.K; k++) guesses.push(this._stretchGuess(k, ctx));
      const L = makeLayout(guesses.map((gs) => gs.m));
      const x = initialUnknowns(L, con.C, guesses);
      // the hold multiplier is a force: rescale it with the normalisation
      if (this.prob && this.hold) this.nu *= (N.Lref / this.prob.N.Lref) ** 2;
      const P = this._makeProblem(L, x, con, N);
      if (!x.every(Number.isFinite)) {
        this.status = 'failed';
        this._restoreGood();
        return;
      }
      this.prob = P;
      this.x = x;
      this.status = 'converging';
    }

    // The line to start from, in normalised units, with the parameter (arc
    // length) of each pin on it: the old centreline, extended to pins beyond its
    // ends, or for a fresh start the polyline through the pin centres.
    // Returns {pts, cum, tOf}; guesses the sides of new pins at the ends.
    _startLine(shape, N) {
      let line = shape && shape.nodes.length >= 2 ? this._lineFromShape(shape, N) : null;
      if (!line) {
        const pts = this.pins.map((p) => this.toN(N, p.x, p.y));
        const c = cumLen(pts);
        line = { pts, tOf: new Map(this.pins.map((p, i) => [p.id, c[i]])) };
        this._guessSidesFresh(pts);
      }
      line.cum = cumLen(line.pts);
      if (line.cum[line.cum.length - 1] === 0) {
        line.pts = [
          [0, 0],
          [1e-6, 0],
        ];
        line.cum = cumLen(line.pts);
      }
      return line;
    }

    // The old centreline and its pin parameters, extended straight to the pins
    // before its first and after its last pin; null if no pin lies on it.
    _lineFromShape(shape, N) {
      const pins = this.pins;
      const pts = shape.nodes.map((p) => this.toN(N, p[0], p[1]));
      const tOf = new Map();
      for (const [id, t] of shape.params) tOf.set(id, t / N.Lref);
      const first = pins.findIndex((p) => tOf.has(p.id));
      if (first < 0) return null;
      let last = pins.length - 1;
      while (!tOf.has(pins[last].id)) last--;
      const startExt = [];
      const endExt = [];
      for (let i = 0; i < first; i++) startExt.push(i);
      for (let i = last + 1; i < pins.length; i++) endExt.push(i);
      if (!startExt.length && !endExt.length) return { pts, tOf };
      // side guesses at a newly extended end
      if (startExt.length) this._guessSidesAtEnd(pts, tOf, startExt, true, N);
      if (endExt.length) this._guessSidesAtEnd(pts, tOf, endExt, false, N);
      const pre = startExt.map((i) => this.toN(N, pins[i].x, pins[i].y));
      const post = endExt.map((i) => this.toN(N, pins[i].x, pins[i].y));
      const all = pre.concat(pts, post);
      let off = 0;
      for (let i = 0; i < pre.length; i++) {
        off += Math.hypot(all[i + 1][0] - all[i][0], all[i + 1][1] - all[i][1]);
      }
      for (const [id, t] of tOf) tOf.set(id, t + off);
      const c = cumLen(all);
      startExt.forEach((pi, i) => tOf.set(pins[pi].id, c[i]));
      endExt.forEach((pi, i) => tOf.set(pins[pi].id, c[pre.length + pts.length + i]));
      return { pts: all, tOf };
    }

    // Parameters for pins new mid-strip: the closest point of the line between
    // their neighbours' parameters. A new Auto pin takes the side it lies on.
    _placeNewPins(line, isNew, N) {
      const { pts, cum, tOf } = line;
      const pins = this.pins;
      for (let i = 0; i < pins.length; i++) {
        const p = pins[i];
        if (tOf.has(p.id)) continue;
        let lo = 0;
        let hi = cum[cum.length - 1];
        const before = this._neighbourParam(tOf, i, -1);
        const after = this._neighbourParam(tOf, i, 1);
        if (before !== undefined) lo = before;
        if (after !== undefined) hi = after;
        const c = this.toN(N, p.x, p.y);
        const pr = project(pts, cum, c, lo, hi);
        tOf.set(p.id, pr.t);
        if (p.mode === 'auto' && ((isNew && isNew[i]) || p.fresh)) {
          const q = pointAt(pts, cum, pr.t);
          const d = dirAt(pts, cum, pr.t);
          p.side = sgn(cross(d[0], d[1], c[0] - q[0], c[1] - q[1]));
        }
      }
    }
    // The parameter of the nearest pin before (dir −1) or after (+1) pin i that has one.
    _neighbourParam(tOf, i, dir) {
      for (let j = i + dir; j >= 0 && j < this.pins.length; j += dir) {
        if (tOf.has(this.pins[j].id)) return tOf.get(this.pins[j].id);
      }
      return undefined;
    }

    // The engaged pins (indices eng, K stretches between them) with their
    // centres C, sides s, parameters T and initial contact points Qs.
    _engagedContacts(line, N) {
      const { pts, cum, tOf } = line;
      const pins = this.pins;
      const r = this.rEff / N.Lref;
      const eng = [];
      for (let i = 0; i < pins.length; i++) if (pins[i].engaged) eng.push(i);
      const K = eng.length - 1;
      const C = new Float64Array(2 * (K + 1));
      const s = new Int8Array(K + 1);
      const T = new Float64Array(K + 1);
      const Qs = [];
      for (let e = 0; e <= K; e++) {
        const p = pins[eng[e]];
        const c = this.toN(N, p.x, p.y);
        C[2 * e] = c[0];
        C[2 * e + 1] = c[1];
        s[e] = p.side;
        T[e] = tOf.get(p.id);
        const d = dirAt(pts, cum, T[e]);
        Qs.push([c[0] - p.side * r * -d[1], c[1] - p.side * r * d[0]]);
      }
      return { eng, K, C, s, T, Qs, r };
    }

    // First guess for stretch k: its segment count m, m+1 points along the line
    // blended to land on the contact points, and the internal force λ (from the
    // old stretch covering its midpoint).
    _stretchGuess(k, { shape, line, con, mOverride, N }) {
      const { pts, cum } = line;
      const { eng, T, Qs } = con;
      const ida = this.pins[eng[k]].id;
      const idb = this.pins[eng[k + 1]].id;
      const ta = T[k];
      const tb = T[k + 1];
      const key = `${ida}|${idb}`;
      const oldStr = shape ? shape.stretches : [];
      const prev = oldStr.find((o) => o.a === ida && o.b === idb);
      const straight = !(tb > ta);
      let m;
      if (mOverride && mOverride.has(key)) m = mOverride.get(key);
      else if (prev) m = prev.m;
      else m = straight ? M_MIN : segsForTurn(turnOf(pts, cum, ta, tb));
      const sp = [];
      for (let j = 0; j <= m; j++) {
        const u = j / m;
        sp.push(straight ? [Qs[k][0], Qs[k][1]] : pointAt(pts, cum, ta + u * (tb - ta)));
      }
      // blend so the ends land on the contact points
      const dax = Qs[k][0] - sp[0][0];
      const day = Qs[k][1] - sp[0][1];
      const dbx = Qs[k + 1][0] - sp[m][0];
      const dby = Qs[k + 1][1] - sp[m][1];
      for (let j = 0; j <= m; j++) {
        const u = j / m;
        sp[j][0] += dax * (1 - u) + dbx * u;
        sp[j][1] += day * (1 - u) + dby * u;
      }
      let lam = [0, 0];
      if (shape) {
        const tm = 0.5 * (ta + tb) * N.Lref;
        const o = prev || oldStr.find((o2) => o2.t0 <= tm && tm <= o2.t1);
        if (o && !straight) lam = [o.lam[0] * N.Lref * N.Lref, -o.lam[1] * N.Lref * N.Lref];
      }
      return { m, sp, lam };
    }

    // The discretised problem for layout L, with every field it will ever have.
    _makeProblem(L, x, con, N) {
      const { eng, C, s, r } = con;
      const cap = Math.min(this._capLimit(), this.capN === null ? Infinity : this.capN);
      const n = L.n;
      const P = {
        L,
        C,
        s,
        r,
        tau: this.hold ? this.nu : 0,
        cap,
        N,
        eng,
        engIds: eng.map((i) => this.pins[i].id),
        sig: this._signature(),
        noHold: false, // the contact geometry alone fixes the length: nothing to hold
        b: 0,
        W: 0,
        bz: 0, // bᵀK⁻¹b for the bordered length row
        // work arrays
        g: new Float64Array(n),
        dx: new Float64Array(n),
        perm: new Int32Array(n),
        rowEnd: new Int32Array(n),
        zb: new Float64Array(n),
        xt: new Float64Array(n),
        g2: new Float64Array(n),
        xs: new Float64Array(n),
        soc: new Float64Array(n),
        A: null,
        Aw: null,
      };
      P.b = bandwidthOf(P, x);
      P.W = 3 * P.b + 1;
      P.A = new Float64Array(n * P.W);
      P.Aw = new Float64Array(n * P.W);
      return P;
    }

    _guessSidesFresh(pts) {
      const pins = this.pins;
      const n = pins.length;
      const turnSide = new Array(n).fill(0);
      for (let i = 1; i < n - 1; i++) {
        const ax = pts[i][0] - pts[i - 1][0];
        const ay = pts[i][1] - pts[i - 1][1];
        const bx = pts[i + 1][0] - pts[i][0];
        const by = pts[i + 1][1] - pts[i][1];
        turnSide[i] = sgn(cross(ax, ay, bx, by));
      }
      for (let i = 1; i < n - 1; i++) {
        if (pins[i].mode === 'auto' && pins[i].fresh) pins[i].side = turnSide[i];
      }
      if (n >= 3) {
        // a Through neighbour has no side: use the bend direction there instead
        if (pins[0].mode === 'auto' && pins[0].fresh) pins[0].side = -(pins[1].side || turnSide[1]);
        if (pins[n - 1].mode === 'auto' && pins[n - 1].fresh) {
          pins[n - 1].side = -(pins[n - 2].side || turnSide[n - 2]);
        }
      } else {
        for (const p of pins) if (p.mode === 'auto' && p.fresh) p.side = 1;
      }
    }

    // A pin added beyond an end: the old end pin turns into an interior pin.
    _guessSidesAtEnd(pts, tOf, ext, atStart, N) {
      const pins = this.pins;
      const cum = cumLen(pts);
      const oldEndIdx = atStart ? ext[ext.length - 1] + 1 : ext[0] - 1;
      const oe = pins[oldEndIdx];
      const t = tOf.get(oe.id);
      const d = dirAt(pts, cum, t);
      const newEnd = pins[atStart ? ext[ext.length - 1] : ext[0]];
      const c0 = this.toN(N, oe.x, oe.y);
      const c1 = this.toN(N, newEnd.x, newEnd.y);
      let vx = c1[0] - c0[0];
      let vy = c1[1] - c0[1];
      if (atStart) {
        vx = -vx;
        vy = -vy;
      }
      const vl = Math.hypot(vx, vy);
      const cr = atStart ? cross(vx, vy, d[0], d[1]) : cross(d[0], d[1], vx, vy);
      if (oe.mode === 'auto' && vl > 0 && Math.abs(cr) > 1e-3 * vl) oe.side = sgn(cr);
      const oeSide = oe.side || sgn(cr); // a Through pin has no side
      for (const pi of ext) {
        const p = pins[pi];
        if (p.mode === 'auto' && p.fresh) {
          p.side = vl > 0 && Math.abs(cr) > 1e-3 * vl ? -oeSide : oeSide;
          p.fresh = false;
        }
      }
    }

    // The last converged shape, shown when a later solve fails. Its problem
    // records the layout it was built for (prob.sig), so result() can tell when
    // it belongs to an earlier layout (stale). The held length search changes
    // prob.cap after this is saved, so the cap is kept as well.
    _saveGood() {
      this.lastGood = {
        prob: this.prob,
        x: Float64Array.from(this.x),
        hold: this.hold,
        nu: this.nu,
        cap: this.prob.cap,
        capN: this.capN,
      };
    }
    _restoreGood() {
      const g = this.lastGood;
      if (!g) return;
      this.prob = g.prob;
      this.x = Float64Array.from(g.x);
      this.hold = g.hold;
      this.nu = g.nu;
      this.prob.cap = g.cap;
      this.capN = g.capN;
    }
    // What a shape depends on: the pins the strip sees, and the settings.
    _signature() {
      const st = this.settings;
      return JSON.stringify([
        this.pins.map((p) => [p.id, p.x, p.y, p.mode]),
        st.d,
        st.t,
        st.holdFactor,
      ]);
    }

    // ---------------------------------------------------------------- Newton
    _assemble(x, wantH) {
      const P = this.prob;
      const b = P.b;
      const W = P.W;
      const A = P.A;
      let addS = null;
      if (wantH) {
        A.fill(0);
        addS = (i, j, v) => {
          if (i === j) A[i * W + b] += v;
          else {
            A[i * W + (j - i + b)] += v;
            A[j * W + (i - j + b)] += v;
          }
        };
      }
      return evaluate(P, x, P.g, addS);
    }

    // Length vector b (∂len/∂x: m_k at each h_k) dotted with v.
    _bDot(v) {
      const L = this.prob.L;
      let s = 0;
      for (let k = 0; k < L.K; k++) s += L.m[k] * v[iH(L, k)];
      return s;
    }

    // z = K⁻¹b for the length row b (m_k at each h_k), with the current
    // factorisation, into P.zb; P.bz = bᵀz.
    _lengthRow() {
      const P = this.prob;
      const L = P.L;
      const z = P.zb;
      z.fill(0);
      for (let k = 0; k < L.K; k++) z[iH(L, k)] = L.m[k];
      bandSolve(L.n, P.b, P.Aw, P.perm, z);
      P.bz = this._bDot(z);
    }
    // the length limit, a little above 1 × the pin-to-pin distances at least
    _capLimit() {
      return Math.max(this.settings.holdFactor, 1 + 1e-6);
    }

    // Solve the (damped, factorised) KKT system for rhs in place. With the hold
    // active the system is bordered by the length constraint bᵀdx = −cL; it is
    // solved with the band factorisation and z = K⁻¹b (P.zb). Returns dν.
    _solveKKT(rhs, cL) {
      const P = this.prob;
      const n = P.L.n;
      bandSolve(n, P.b, P.Aw, P.perm, rhs);
      if (!this.hold) return 0;
      const z = P.zb;
      const bz = P.bz;
      const dnu = (this._bDot(rhs) + cL) / bz;
      for (let i = 0; i < n; i++) rhs[i] -= dnu * z[i];
      return dnu;
    }

    // One damped Newton iteration. Returns 'accepted' | 'rejected' | 'converged'.
    _iterate() {
      work.iterations++;
      const P = this.prob;
      const L = P.L;
      P.tau = this.hold ? this.nu : 0;
      const ev0 = this._assemble(this.x, true);
      // diagonal scale for the damping floor
      let thDiag = 0;
      for (let k = 0; k < L.K; k++) thDiag = Math.max(thDiag, 4 / this.x[iH(L, k)]);
      // A rejected step raises μ and also backtracks: damping alone does not
      // shrink the part of the step that restores the contact constraints.
      let shrink = 1;
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++, shrink *= 0.5) {
        const res = this._attempt(ev0, thDiag, shrink);
        if (res) return res;
        this.mu = Math.min(this.mu * 4, MU_MAX);
      }
      return 'rejected';
    }

    // One attempt at a Newton step with the current damping μ, shortened by
    // shrink. Returns 'accepted' or 'converged', or null when it fails.
    _attempt(ev0, thDiag, shrink) {
      const P = this.prob;
      const mu = this.mu;
      if (!this._factorise(mu, thDiag)) return null;
      if (this.hold && !this._borderHold(mu)) return 'accepted';
      const dx = P.dx;
      for (let i = 0; i < P.L.n; i++) dx[i] = -P.g[i];
      const dnu = this._solveKKT(dx, ev0.len - P.cap);
      const step = this._trialPoint(dnu, shrink);
      if (!step) return null;
      const merit = this._merit(ev0, step.alpha, dnu);
      const m0 = merit(ev0);
      const tol = 1e-12 * (Math.abs(m0) + 1);
      const trial = this._trialMerit(merit, m0, tol);
      if (!(Number.isFinite(trial.m) && trial.m <= m0 + tol)) return null;
      return this._accept(trial.ev, step, dnu, mu);
    }

    // Factorise the Hessian with Marquardt damping μ on the angles and lengths.
    _factorise(mu, thDiag) {
      const P = this.prob;
      const { L, b, W, Aw } = P;
      const x = this.x;
      Aw.set(P.A);
      for (let k = 0; k < L.K; k++) {
        const m = L.m[k];
        const ih = iH(L, k);
        const h = x[ih];
        for (let j = 0; j < m; j++) {
          const it = iTh(L, k, j);
          const d = Aw[it * W + b];
          Aw[it * W + b] += mu * Math.max(Math.abs(d), 1e-6 * thDiag);
        }
        const d = Aw[ih * W + b];
        // floor in the scale of ln h, so it is consistent with the θ floor
        Aw[ih * W + b] += mu * Math.max(Math.abs(d), (1e-6 * thDiag) / (h * h));
      }
      return bandLU(L.n, b, Aw, P.perm, P.rowEnd);
    }

    // With the hold on, the length constraint borders the system: z = K⁻¹b.
    // bᵀK⁻¹b is zero when the contact geometry alone fixes the length: nothing
    // to hold. Compare with what a diagonal matrix of the same size would give,
    // so heavy damping is not mistaken for that. Returns false, and lets go of
    // the hold, when there is nothing to hold.
    _borderHold(mu) {
      const P = this.prob;
      const { L, b, W } = P;
      this._lengthRow();
      let bb = 0;
      let dmax = 0;
      for (let k = 0; k < L.K; k++) bb += L.m[k] * L.m[k];
      for (let i = 0; i < L.n; i++) dmax = Math.max(dmax, Math.abs(P.A[i * W + b]) * (1 + mu));
      if (Math.abs(P.bz) > (1e-12 * bb) / dmax) return true;
      this.hold = false;
      this.nu = 0;
      P.tau = 0;
      P.noHold = true;
      return false;
    }

    // The trial point xt = x + α·dx, with α limited so no segment length shrinks
    // or grows too much and no angle turns too far, then shortened by shrink.
    // Returns {alpha, dthMax}, or null if the step is not finite.
    _trialPoint(dnu, shrink) {
      const P = this.prob;
      const { L, dx, xt } = P;
      const x = this.x;
      let alpha = 1;
      let dthMax = 0;
      for (let k = 0; k < L.K; k++) {
        const m = L.m[k];
        const ih = iH(L, k);
        const h = x[ih];
        const dh = dx[ih];
        for (let j = 0; j < m; j++) dthMax = Math.max(dthMax, Math.abs(dx[iTh(L, k, j)]));
        if (dh < 0) alpha = Math.min(alpha, ((1 - H_SHRINK) * h) / -dh);
        else if (dh > 0) alpha = Math.min(alpha, ((H_GROW - 1) * h) / dh);
      }
      if (dthMax > MAX_DTHETA) alpha = Math.min(alpha, MAX_DTHETA / dthMax);
      alpha *= shrink;
      if (!Number.isFinite(alpha) || Number.isNaN(dthMax) || !Number.isFinite(dnu)) return null;
      for (let i = 0; i < L.n; i++) {
        xt[i] = x[i] + alpha * dx[i];
        if (!Number.isFinite(xt[i])) return null;
      }
      return { alpha, dthMax };
    }

    // The exact-penalty merit function for this step. Its weights cap the trial
    // multipliers, because under heavy damping Δλ can be meaningless and would
    // freeze the iteration. The hold tension is a force like the contact
    // multipliers, so its cap also scales with them: when the hold has just
    // come on (ν = 0, the strip past the limit) a cap of 10 alone is below the
    // tension needed, and every step back to the limit would be rejected.
    _merit(ev0, alpha, dnu) {
      const P = this.prob;
      const { L, xt, cap } = P;
      const lamNew = maxMultiplier(L, xt);
      const rho = 2 * Math.max(ev0.lamMax, Math.min(lamNew, 10 * (ev0.lamMax + 1))) + 1;
      const nuAbs = Math.abs(this.nu);
      const nuCap = 10 * (Math.max(nuAbs, ev0.lamMax) + 1);
      const rhoL = this.hold
        ? 2 * Math.max(nuAbs, Math.min(Math.abs(this.nu + alpha * dnu), nuCap)) + 1
        : 0;
      return (ev) => ev.E + rho * ev.conSum + rhoL * Math.abs(ev.len - cap);
    }

    // The merit at the trial point. A long stretch rotated by a full Newton step
    // leaves a second-order closure error that the merit function punishes (the
    // Maratos effect): if the step fails, restore the constraints with the same
    // factorisation and test again. Returns {ev, m}.
    _trialMerit(merit, m0, tol) {
      const P = this.prob;
      const xt = P.xt;
      let ev = evaluate(P, xt, P.g2, null);
      let m = merit(ev);
      if (Number.isFinite(m) && !(m <= m0 + tol)) {
        P.xs.set(xt);
        if (this._secondOrderCorrection(P.xs, ev.len - P.cap)) {
          const ev2 = evaluate(P, P.xs, null, null);
          const m2 = merit(ev2);
          if (m2 < m) {
            ev = ev2;
            m = m2;
            xt.set(P.xs);
          }
        }
      }
      return { ev, m };
    }

    // Take the trial point. Converged when the step, the closure errors, the
    // length (when held) and the damping are all small. A stretch's length step
    // counts relative to its segment length, or to 1/m (a stretch length of
    // L_ref) when that is larger: a stretch between overlapping pins can
    // shrink towards zero length (their contact points merging), creeping by a
    // fixed fraction per step for ever while the shape no longer changes.
    _accept(ev1, step, dnu, mu) {
      const P = this.prob;
      const { L, dx } = P;
      const x = this.x;
      const { alpha, dthMax } = step;
      x.set(P.xt);
      if (this.hold) this.nu += alpha * dnu;
      this.mu = Math.max(this.mu / 3, MU_MIN);
      let dhRel = 0;
      for (let k = 0; k < L.K; k++) {
        const ih = iH(L, k);
        dhRel = Math.max(dhRel, Math.abs(alpha * dx[ih]) / Math.max(x[ih], 1 / L.m[k]));
      }
      const lenOk = !this.hold || Math.abs(ev1.len - P.cap) < TOL_CON;
      const conv =
        alpha * dthMax < TOL_STEP &&
        dhRel < TOL_STEP &&
        ev1.con < TOL_CON &&
        lenOk &&
        mu < MU_CONVERGED;
      return conv ? 'converged' : 'accepted';
    }

    // Second-order correction: solve K·d = [0; −c(xt)] (and the length residual
    // when held) with the factorisation still held in P.Aw. P.g2 holds the
    // gradient at xt, whose λ rows are c. Adds the primal part of d to xt.
    // Returns false if that would be unsafe.
    _secondOrderCorrection(xt, cL) {
      const P = this.prob;
      const L = P.L;
      const d = P.soc;
      d.fill(0);
      for (let k = 0; k < L.K; k++) {
        const ih = iH(L, k);
        d[ih + 1] = -P.g2[ih + 1];
        d[ih + 2] = -P.g2[ih + 2];
      }
      this._solveKKT(d, cL);
      for (let k = 0; k < L.K; k++) {
        const ih = iH(L, k);
        if (!(xt[ih] + d[ih] > H_SHRINK * xt[ih] && xt[ih] + d[ih] < H_GROW * xt[ih])) return false;
        for (let j = 0; j < L.m[k]; j++) {
          const v = d[iTh(L, k, j)];
          if (!(Math.abs(v) <= MAX_DTHETA)) return false;
        }
      }
      for (let k = 0; k < L.K; k++) {
        const ih = iH(L, k);
        xt[ih] += d[ih];
        for (let j = 0; j < L.m[k]; j++) xt[iTh(L, k, j)] += d[iTh(L, k, j)];
      }
      return true;
    }

    // ------------------------------------------------------------- stability
    // Newton finds any equilibrium, also an unstable one: a saddle, where some
    // small displacement the constraints allow lowers the energy (near the
    // slide-out limit of a hairpin, for example). A shape is a stable
    // equilibrium when the Hessian of the Lagrangian is positive definite on the
    // displacements the constraints allow, i.e. when the KKT matrix has exactly
    // as many negative eigenvalues as there are constraints. The sign of its
    // determinant, from the band LU, gives the parity of that count, which
    // catches the usual case of one unstable direction. Shift-invert Lanczos
    // with the same factorisation then estimates that direction's curvature,
    // and inverse iteration shifted there finds the direction.
    // Returns the direction (λ entries 0), or null when the shape is stable or
    // no clearly unstable direction is found.
    _unstableDirection() {
      const P = this.prob;
      const L = P.L;
      P.tau = this.hold ? this.nu : 0;
      this._assemble(this.x, true);
      const dual = dualMask(L);
      const ncon = 2 * L.K + (this.hold ? 1 : 0);
      const odd = this._factorShifted(0, dual);
      if (odd === null || odd === (ncon & 1)) return null;
      // v ↦ the angle and length part of K⁻¹[v; 0]: the inverse of the Hessian
      // restricted to the displacements the constraints allow
      const op = (v, w) => this._reducedInverse(v, w, dual);
      let free = -ncon;
      for (let k = 0; k < L.K; k++) free += L.m[k] + 1;
      const ritz = lowestRitz(op, startVector(dual), Math.min(LANCZOS_MAX, free));
      if (!ritz) return null;
      // the curvature along it is about 1/τ: refine by inverse iteration shifted there
      const sigma = 1 / ritz.value;
      if (
        this._factorShifted(sigma, dual) === null &&
        this._factorShifted(sigma * (1 + 1e-3), dual) === null
      ) {
        return null;
      }
      const y = inverseIteration(op, ritz.vector, 4);
      return y && this._clearlyNegative(y, dual) ? y : null;
    }

    // Factorise K − σ·I (σ on the angles and lengths only, bordered by the
    // length row when held). Returns the parity of its negative eigenvalues, or
    // null if singular.
    _factorShifted(sigma, dual) {
      const P = this.prob;
      const { L, b, W, Aw } = P;
      const n = L.n;
      Aw.set(P.A);
      if (sigma) for (let i = 0; i < n; i++) if (!dual[i]) Aw[i * W + b] -= sigma;
      if (!bandLU(n, b, Aw, P.perm, P.rowEnd)) return null;
      let odd = 0;
      for (let k = 0; k < n; k++) {
        if (P.perm[k] !== k) odd ^= 1;
        if (Aw[k * W + b] < 0) odd ^= 1;
      }
      if (!this.hold) return odd;
      this._lengthRow();
      if (!(P.bz !== 0) || !Number.isFinite(P.bz)) return null;
      if (P.bz > 0) odd ^= 1; // det [K b; bᵀ 0] = −det K · bᵀK⁻¹b
      return odd;
    }

    // The angle and length part of K⁻¹[v; 0], with the current factorisation, into w.
    _reducedInverse(v, w = new Float64Array(v.length), dual) {
      w.set(v);
      this._solveKKT(w, 0);
      for (let i = 0; i < w.length; i++) if (dual[i]) w[i] = 0;
      return w;
    }

    // Is the Hessian's curvature along y clearly negative (not rounding)?
    _clearlyNegative(y, dual) {
      const P = this.prob;
      const { b, W, A } = P;
      const Hy = bandMul(y.length, b, A, y);
      let yHy = 0;
      let dmax = 0;
      for (let i = 0; i < y.length; i++) {
        if (!dual[i]) {
          yHy += y[i] * Hy[i];
          dmax = Math.max(dmax, Math.abs(A[i * W + b]));
        }
      }
      return yHy < -UNSTABLE_TOL * dmax;
    }

    // At a would-be result: if it is an unstable equilibrium, push the shape a
    // little along the unstable direction (whichever way lowers the energy) and
    // let Newton carry on. After MAX_ESCAPES pushes per user change the shape is
    // kept and flagged unstable. Returns true when it pushed.
    _escapeIfUnstable() {
      this.unstable = false;
      const t0 = now();
      const y = this._unstableDirection();
      if (!y) return false;
      work.searches++;
      work.slowestSearchMs = Math.max(work.slowestSearchMs, now() - t0);
      if (this.escapes >= MAX_ESCAPES) {
        this.unstable = true;
        return false;
      }
      this.escapes++;
      const P = this.prob;
      const L = P.L;
      const x = this.x;
      let step = Infinity;
      for (let k = 0; k < L.K; k++) {
        const ih = iH(L, k);
        if (y[ih] !== 0) step = Math.min(step, (ESCAPE_DH * x[ih]) / Math.abs(y[ih]));
        for (let j = 0; j < L.m[k]; j++) {
          const v = Math.abs(y[iTh(L, k, j)]);
          if (v > 0) step = Math.min(step, ESCAPE_DTHETA / v);
        }
      }
      if (!Number.isFinite(step)) return false;
      let best = null;
      for (const sg of [1, -1]) {
        const xt = Float64Array.from(x);
        for (let i = 0; i < xt.length; i++) xt[i] += sg * step * y[i];
        const ev = evaluate(P, xt, null, null);
        const m = ev.E + (2 * ev.lamMax + 1) * ev.conSum;
        if (!best || m < best.m) best = { xt, m };
      }
      x.set(best.xt);
      this.mu = MU_INIT;
      return true;
    }

    // ------------------------------------------------------- post-convergence
    // Forces on the strip at engaged pins (normalised, y up).
    _forces() {
      const P = this.prob;
      const L = P.L;
      const K = L.K;
      const x = this.x;
      const F = [];
      for (let i = 0; i <= K; i++) {
        let fx = 0;
        let fy = 0;
        if (i < K) {
          const ih = iH(L, i);
          fx += x[ih + 1];
          fy += x[ih + 2];
        }
        if (i > 0) {
          const ih = iH(L, i - 1);
          fx -= x[ih + 1];
          fy -= x[ih + 2];
        }
        F.push([fx, fy]);
      }
      return F;
    }

    _maxSegAngles() {
      const P = this.prob;
      const L = P.L;
      const x = this.x;
      const out = [];
      for (let k = 0; k < L.K; k++) {
        let mx = 0;
        for (let j = 1; j < L.m[k]; j++) {
          mx = Math.max(mx, Math.abs(x[iTh(L, k, j)] - x[iTh(L, k, j - 1)]));
        }
        out.push(mx);
      }
      return out;
    }

    _refine() {
      const P = this.prob;
      const L = P.L;
      const ang = this._maxSegAngles();
      const over = new Map();
      for (let k = 0; k < L.K; k++) {
        const m = L.m[k];
        const a = ang[k];
        let mNew = m;
        if (
          (a > REFINE_HI * SEG_TARGET && m < M_MAX) ||
          (a < REFINE_LO * SEG_TARGET && m > M_MIN)
        ) {
          mNew = clampM(Math.ceil((m * a) / SEG_TARGET));
        }
        if (mNew !== m) over.set(`${P.engIds[k]}|${P.engIds[k + 1]}`, mNew);
      }
      if (!over.size) return false;
      this._rebuild(this.shape(), null, over);
      return true;
    }

    // One contact change (the most violated), or none. Returns true if changed.
    _contacts() {
      const best = this._worstContact();
      if (!best || !this._changeContact(best.act)) return false;
      this._rebuild(this.shape());
      return true;
    }

    // The most violated contact: an engaged pin that pulls (an Auto pin is
    // flipped, an interior Left/Right one released), or a released pin the strip
    // cuts into (engaged again). Records each pin's press and gap.
    // Returns {score, act: {type, p}} or null.
    _worstContact() {
      let best = null;
      const consider = (score, act) => {
        if (!best || score > best.score) best = { score, act };
      };
      this._pullingPins(consider);
      this._cutPins(consider);
      return best;
    }

    _pullingPins(consider) {
      const P = this.prob;
      const K = P.L.K;
      const F = this._forces();
      const ev = evaluate(P, this.x, null, null);
      const Fmax = maxForce(F);
      const thr = HYST * Fmax;
      for (let e = 0; e <= K; e++) {
        const p = this.pins[P.eng[e]];
        const press = pressOf(F[e], ev.phi[e], P.s[e]);
        p.press = press / Fmax;
        if (press >= -thr || p.marginal) continue;
        if (p.mode === 'auto') consider(-press / Fmax, { type: 'flip', p });
        else if (sided(p) && e > 0 && e < K) consider(-press / Fmax, { type: 'release', p });
      }
    }

    // released pins that the strip cuts into
    _cutPins(consider) {
      const sh = this.shape();
      if (!sh) return;
      const { N, r: rN } = this.prob;
      for (const p of this.pins) {
        p.gap = null;
        if (p.engaged || !sh.params.has(p.id)) continue;
        const t = sh.params.get(p.id);
        const q = pointAt(sh.nodes, sh.cum, t);
        const d = dirAt(sh.nodes, sh.cum, t);
        // y down in mm: left normal on screen is (d.y, -d.x)
        const gap = (p.side * ((p.x - q[0]) * d[1] + (p.y - q[1]) * -d[0])) / N.Lref - rN;
        p.gap = gap / rN;
        if (gap < -HYST * rN && !p.marginal) consider(-gap / rN, { type: 'engage', p });
      }
    }

    // Make the change, unless the pin keeps changing: then freeze it
    // ("marginal") instead and return false.
    _changeContact({ type, p }) {
      p.events = (p.events || 0) + 1;
      const tooMany = type === 'flip' ? p.flips >= MAX_FLIPS : p.events > 2 * MAX_FLIPS;
      if (tooMany) {
        p.marginal = true;
        return false;
      }
      if (type === 'flip') {
        p.flips++;
        p.side = -p.side;
      } else p.engaged = type === 'engage';
      return true;
    }

    // ----------------------------------------------------------------- driver
    // Run for up to budgetMs. Returns true while more work is pending. An
    // iteration is not started when the running estimate of its time would
    // overrun the budget, but every call does at least one.
    // With maxIter, stop after that many Newton iterations instead (tests use
    // this to be independent of machine speed); budgetMs is then ignored.
    run(budgetMs, maxIter) {
      if (!this.prob || IDLE.has(this.status)) return false;
      const slice = {
        t0: now(),
        budget: maxIter === undefined ? budgetMs : Infinity,
        maxIter,
        itersLeft: maxIter === undefined ? Infinity : maxIter,
        worked: false, // a Newton iteration ran in this call
      };
      // resume: the last call stopped after a converged iteration, leaving what
      // follows it (the stability check, a fresh candidate's solve) to this one,
      // which carries on from there without iterating again
      let resumed = this.resume;
      this.resume = false;
      do {
        let verdict;
        if (resumed) {
          resumed = false;
          verdict = this._afterConvergence(slice);
        } else {
          const res = this._timedIteration(slice);
          verdict = res === 'converged' ? this._afterConvergence(slice) : this._afterStep(res);
        }
        if (verdict !== 'continue') return verdict === 'pending';
      } while (now() - slice.t0 + this.iterMs < slice.budget && slice.itersLeft > 0);
      return true;
    }

    _timedIteration(slice) {
      const ti = now();
      const res = this._iterate();
      const dt = now() - ti;
      this.iterMs = this.iterMs > 0 ? 0.8 * this.iterMs + 0.2 * dt : dt;
      this.iter++;
      this.totalIter++;
      slice.itersLeft--;
      slice.worked = true;
      return res;
    }

    // After an iteration that did not converge. Returns 'continue' or 'done'.
    _afterStep(res) {
      if (res === 'rejected' && this.mu >= MU_MAX) {
        this.status = 'failed';
        this._restoreGood();
        return 'done';
      }
      if (this.iter > MAX_ITER_SETTLE) {
        this.status = 'stalled';
        return 'done';
      }
      // a fully rejected step during a held length search: the length asked
      // for cannot be reached (e.g. after a contact change); back to the limit
      if (res === 'rejected' && this.hold && this.cs && !this.cs.failed && this.capN !== null) {
        this._abandonHold();
        return 'continue';
      }
      if (
        res !== 'rejected' &&
        !this.hold &&
        !this.prob.noHold &&
        evaluate(this.prob, this.x, null, null).len > this.prob.cap
      ) {
        // the strip is sliding out: friction at the end pins holds its length
        this.hold = true;
        this.nu = 0;
      }
      return 'continue';
    }

    // After a converged iteration: the hold, refinement, the held length,
    // contact changes, the stability check and the fresh re-solve, any of which
    // may need more iterations. Returns 'continue', 'pending' (more in the next
    // call) or 'done'.
    _afterConvergence(slice) {
      if (this.hold && this._releaseHold()) return 'continue';
      this._saveGood();
      // contacts, refinement or the held length search did not settle
      if (this.rounds++ > MAX_ROUNDS) {
        this.status = 'stalled';
        return 'done';
      }
      if (this._refine()) return 'continue';
      if (this.hold ? this._adjustHold() : this._clearCapN()) return 'continue';
      if (this._contacts()) return 'continue';
      // the stability check costs about one iteration: the next call, if this one has no time left
      if (!this.cand && slice.worked && now() - slice.t0 + this.iterMs >= slice.budget) {
        this.resume = true;
        return 'pending';
      }
      if (!this.cand && this._escapeIfUnstable()) return 'continue';
      const poor = this.hold || this.unstable || this._manualReleased() || !this._valid();
      if (poor && !this.isCandidate && !this.candDone) return this._freshSolve(slice);
      this._finish();
      return 'done';
    }

    // The shape reached by following the user's edits can be a poor
    // equilibrium: a held strip in a looped basin, or a strip that snapped off
    // Left/Right pins and stays off them when the pins come back. Solve the
    // layout again from scratch with every pin touching (over the next frames)
    // and keep the better result, so the shape depends on the layout rather
    // than on how it was reached. If that is still not a valid resting shape,
    // also start from the other extreme with the interior Left/Right pins
    // released. Returns 'continue' or 'pending'.
    _freshSolve(slice) {
      if (!this.cand) {
        // a fresh start exactly like the one this solve began from would
        // only retrace it (the solver is deterministic): skip it
        const c = this._freshCandidate(this.candKind === 'none');
        if (!this._sameStart(c)) this.cand = c;
      }
      if (this.cand) {
        const left = slice.budget - (now() - slice.t0);
        const before = this.cand.totalIter;
        const iters = slice.maxIter === undefined ? undefined : Math.max(slice.itersLeft, 1);
        const pending = this.cand.run(Math.max(left, 1), iters);
        slice.itersLeft -= this.cand.totalIter - before;
        if (pending) {
          this.resume = true;
          return 'pending';
        }
        this._adoptCandidate();
      }
      if (this.candKind !== 'none' && !this._valid() && this._hasManualInterior()) {
        this.candKind = 'none';
      } else this.candDone = true;
      return 'continue';
    }

    _freshCandidate(released) {
      const c = new Strip(this.settings);
      c.isCandidate = true;
      c.setState({
        pins: this.pins.map((p) => ({
          id: p.id,
          x: p.x,
          y: p.y,
          mode: p.mode,
          side: p.mode === 'auto' ? 0 : p.side,
          engaged: !(released && sided(p)),
        })),
        shape: null,
      });
      return c;
    }
    // Where this solve started (after the user change): unknowns, segment
    // counts and pin states.
    _markStart() {
      this.start = this.prob
        ? {
            x: Float64Array.from(this.x),
            m: Array.from(this.prob.L.m).join(','),
            pins: this.pins.map((p) => `${p.side}:${p.engaged}`).join(','),
          }
        : null;
    }
    // Does strip c start exactly where this solve started?
    _sameStart(c) {
      const s = this.start;
      if (!s || !c.prob || c.x.length !== s.x.length || Array.from(c.prob.L.m).join(',') !== s.m) {
        return false;
      }
      for (let i = 0; i < s.x.length; i++) if (c.x[i] !== s.x[i]) return false;
      return c.pins.map((p) => `${p.side}:${p.engaged}`).join(',') === s.pins;
    }
    _hasManualInterior() {
      return this.pins.some((p, i) => sided(p) && i > 0 && i < this.pins.length - 1);
    }
    _manualReleased() {
      return this.pins.some((p) => sided(p) && !p.engaged);
    }
    // A valid resting shape: no Left/Right pin it touches pulls on the strip
    // (end pins are never released, so they can end up pulling).
    _valid() {
      return !this.result().pins.some((p) => p.engaged && sided(p) && p.press < -HYST);
    }
    // Better = stable (an unstable equilibrium is no resting shape), then valid,
    // then more pins in contact (the Left/Right sides the user asked for), then
    // not held at the length limit, then less bending energy.
    _adoptCandidate() {
      const c = this.cand;
      this.cand = null;
      if (!c.prob || (c.status !== 'converged' && c.status !== 'friction')) return;
      const vMine = this._valid();
      const vCand = c._valid();
      const nMine = this.pins.filter((p) => p.engaged).length;
      const nCand = c.pins.filter((p) => p.engaged).length;
      const eMine = evaluate(this.prob, this.x, null, null).E;
      const eCand = evaluate(c.prob, c.x, null, null).E;
      let better;
      if (c.unstable !== this.unstable) better = !c.unstable;
      else if (vCand !== vMine) better = vCand;
      else if (nCand !== nMine) better = nCand > nMine;
      else if (c.hold !== this.hold) better = !c.hold;
      else better = eCand < eMine * (1 - 1e-6);
      if (!better) return;
      this.prob = c.prob;
      this.x = c.x;
      this.hold = c.hold;
      this.nu = c.nu;
      this.unstable = c.unstable;
      const byId = new Map(c.pins.map((p) => [p.id, p]));
      for (const p of this.pins) {
        const q = byId.get(p.id);
        if (q) {
          p.side = q.side;
          p.engaged = q.engaged;
          p.marginal = q.marginal;
        }
      }
      this.rounds = 0;
    }

    // The held length is a modelling choice (in reality friction decides how far
    // the strip slides), so pick the one that keeps the user's pins in contact:
    // the length limit, or the longest length below it at which every Left/Right
    // pin pushes. Shorter makes interior pins push harder and end pins less, so
    // this bisects between "an interior pin pulls" (too long) and "an end pin
    // pulls" (too short). Returns true when it changed the held length.
    _adjustHold() {
      const P = this.prob;
      const L = P.L;
      const K = L.K;
      const ev = evaluate(P, this.x, null, null);
      const F = this._forces();
      const Fs = maxForce(F);
      let gInt = Infinity;
      let gEnd = Infinity;
      for (let e = 0; e <= K; e++) {
        if (!sided(this.pins[P.eng[e]])) continue;
        const press = pressOf(F[e], ev.phi[e], P.s[e]);
        if (e === 0 || e === K) gEnd = Math.min(gEnd, press);
        else gInt = Math.min(gInt, press);
      }
      const len = ev.len;
      if (this.cs && this.cs.failed) return false;
      if (!Number.isFinite(gInt)) return this._reengageForHold(len);
      const thr = HYST * Fs;
      if (gInt < -thr) return this._holdStep(len, 'long', gInt / Fs);
      if (gEnd < -thr) return this._holdStep(len, 'short', gEnd / Fs);
      // valid: done at the limit, or once the weakest interior contact barely pushes
      const cs = this.cs;
      if (
        this.capN !== null &&
        gInt > HOLD_PRESS_TOL * Fs &&
        !(cs && cs.hi !== null && cs.hi - len < 1e-6 * len)
      ) {
        return this._holdStep(len, 'short');
      }
      return this._reengageForHold(len);
    }
    // One step of the held length search: 'long' = the strip is too long here.
    // g is the pulling pin's force relative to the largest one. If several
    // steps in a row do not make it pull less, length is not what makes it pull:
    // give up and go back to the limit.
    _holdStep(len, verdict, g) {
      const P = this.prob;
      const ev = evaluate(P, this.x, null, null);
      const K = P.L.K;
      const capMax = this._capLimit();
      let poly = 0; // the strip can never be shorter than the chords between its contacts
      for (let i = 0; i < K; i++) {
        poly += Math.hypot(ev.Q[2 * i + 2] - ev.Q[2 * i], ev.Q[2 * i + 3] - ev.Q[2 * i + 1]);
      }
      const cs = this.cs || (this.cs = { lo: null, hi: null, n: 0 });
      if (g !== undefined) {
        const best = cs[`best_${verdict}`];
        if (best === undefined || g > best) {
          cs[`best_${verdict}`] = g;
          cs[`stale_${verdict}`] = 0;
        } else if (++cs[`stale_${verdict}`] >= HOLD_PATIENCE) return this._abandonHold();
      }
      if (cs.n++ >= HOLD_SEARCH_MAX) return this._abandonHold();
      if (cs.nu0 === undefined) cs.nu0 = Math.abs(this.nu);
      else if (Math.abs(this.nu) > HOLD_TENSION_GROWTH * cs.nu0) return this._abandonHold();
      if (verdict === 'long') cs.hi = len;
      else cs.lo = len;
      if (cs.lo !== null && cs.hi !== null && cs.hi - cs.lo < 1e-6 * len) {
        return this._abandonHold();
      }
      let next;
      if (cs.lo !== null && cs.hi !== null) next = 0.5 * (cs.lo + cs.hi);
      else if (verdict === 'long') next = len - 0.25 * (len - poly);
      else next = len + 0.25 * (len - poly);
      if (next >= capMax * (1 - 1e-9)) {
        this.capN = null;
        P.cap = capMax;
      } else {
        this.capN = next;
        P.cap = next;
      }
      return true;
    }

    // A Left/Right pin released while the length was still free (the strip then
    // slid out and is now held) is brought back once per user change: engaged
    // again, with the held length searched so that it just pushes.
    _reengageForHold(len) {
      const pins = this.pins;
      const n = pins.length;
      let any = false;
      for (let i = 1; i < n - 1; i++) {
        const p = pins[i];
        if (!sided(p) || p.engaged || p.marginal || p.holdTried) continue;
        p.holdTried = true;
        p.engaged = true;
        any = true;
      }
      if (!any) return false;
      // at the current length the re-engaged pins pull: search downwards from here
      this.cs = { lo: null, hi: len, n: 0 };
      const P = this.prob;
      this.capN = len - 0.25 * (len - 1);
      P.cap = this.capN;
      this._rebuild(this.shape());
      return true;
    }
    // Stop searching until the next user change; contacts decide from here.
    _abandonHold() {
      this.cs.failed = true;
      if (this.capN === null) return false;
      this.capN = null;
      this.prob.cap = this._capLimit();
      return true;
    }
    _clearCapN() {
      if (this.capN === null) return false;
      this.capN = null;
      this.prob.cap = this._capLimit();
      return false;
    }

    // Let go of the length cap when the strip would rather be shorter (ν < 0).
    _releaseHold() {
      if (!(this.nu < -HYST * maxForce(this._forces()))) return false;
      // during a held length search, letting go means this length is beyond the
      // free resting length, where an interior pin pulls: treat it as too long
      if (this.cs && !this.cs.failed && this.capN !== null) {
        return this._holdStep(evaluate(this.prob, this.x, null, null).len, 'long');
      }
      this.hold = false;
      this.nu = 0;
      return true;
    }

    _finish() {
      this.status = this.hold ? 'friction' : 'converged';
    }

    // Run to completion (tests, export).
    solve(maxMs) {
      const lim = maxMs || 1e9;
      const t0 = Date.now();
      while (this.run(50)) if (Date.now() - t0 > lim) break;
      return this.status;
    }

    // ---------------------------------------------------------------- results
    /** @returns {Result} */
    result() {
      const out = this._emptyResult();
      if (!this.prob) {
        const free = (p) => ({
          id: p.id,
          engaged: false,
          side: p.side,
          mode: p.mode,
          warnings: [],
        });
        out.pins = this._userPinResults(new Map(this.pins.map((p) => [p.id, free(p)])));
        return out;
      }
      const P = this.prob;
      const N = P.N;
      out.stale = P.sig !== this._signature();
      const { nodes, nodeOfPin, ev } = this._nodesN();
      out.nodes = nodes.map((p) => this.fromN(N, p[0], p[1]));
      const { tang, curv } = this._tangentsAndCurvature(nodes.length);
      out.tangents = Array.from(tang, (a) => -a);
      out.curvature = Array.from(curv);
      out.length = ev.len * N.Lref;
      let kmax = 0;
      for (let i = 0; i < curv.length; i++) {
        if (Math.abs(curv[i]) > kmax) {
          kmax = Math.abs(curv[i]);
          out.minRadiusAt = out.nodes[i];
        }
      }
      out.minRadius = kmax > 0 ? 1 / kmax : Infinity;
      const F = this._forces();
      const Fmax = maxForce(F);
      const ctx = {
        ev,
        curv,
        nodeOfPin,
        F,
        Fmax,
        out,
        sh: this.shape(),
        engPos: new Map(P.engIds.map((id, e) => [id, e])),
      };
      out.pins = this._userPinResults(
        new Map(this.pins.map((p) => [p.id, this._pinResult(p, ctx)])),
      );
      return out;
    }

    // stale: the shape shown was solved for an earlier layout (after a failed
    // solve, or while the pins are invalid); unstable: an unstable equilibrium
    _emptyResult() {
      return {
        status: this.status,
        held: this.hold,
        heldBelowLimit: this.hold && this.capN !== null,
        muReq: 0,
        holdFactor: this.settings.holdFactor,
        pins: [],
        nodes: [],
        tangents: [],
        curvature: [],
        length: 0,
        minRadius: Infinity,
        minRadiusAt: null,
        rEff: this.rEff,
        iter: this.iter,
        stale: false,
        unstable: Boolean(this.unstable),
        invalid: this.invalid.map((v) => Object.assign({}, v)),
      };
    }

    // Tangent (radians, y up) and signed curvature (1/mm, positive = turning
    // left on screen) at each of the nn nodes; 0 curvature at the ends.
    _tangentsAndCurvature(nn) {
      const { L, N } = this.prob;
      const x = this.x;
      const tang = new Float64Array(nn);
      const curv = new Float64Array(nn);
      const thAt = [];
      const hAt = [];
      for (let k = 0; k < L.K; k++) {
        for (let j = 0; j < L.m[k]; j++) {
          thAt.push(x[iTh(L, k, j)]);
          hAt.push(x[iH(L, k)]);
        }
      }
      tang[0] = thAt[0];
      tang[nn - 1] = thAt[thAt.length - 1];
      for (let i = 1; i < nn - 1; i++) {
        tang[i] = 0.5 * (thAt[i - 1] + thAt[i]);
        curv[i] = (thAt[i] - thAt[i - 1]) / (0.5 * (hAt[i - 1] + hAt[i])) / N.Lref;
      }
      return { tang, curv };
    }

    // The result for one of the pins the strip sees.
    _pinResult(p, ctx) {
      const e = ctx.engPos.get(p.id);
      const o = {
        id: p.id,
        x: p.x,
        y: p.y,
        mode: p.mode,
        side: p.side,
        engaged: e !== undefined,
        marginal: Boolean(p.marginal),
        warnings: [],
      };
      if (e !== undefined) this._contactResult(o, p, e, ctx);
      else {
        o.label = 'free';
        if (ctx.sh && ctx.sh.params.has(p.id)) o.param = ctx.sh.params.get(p.id);
      }
      if (p.marginal) o.warnings.push('marginal');
      return o;
    }

    // An engaged pin: contact point, inside/outside label, force, warnings, and
    // at a held strip's ends the friction needed.
    _contactResult(o, p, e, ctx) {
      const { N, L } = this.prob;
      const { ev, curv, nodeOfPin, F, Fmax, out } = ctx;
      const K = L.K;
      const nn = curv.length;
      o.contact = this.fromN(N, ev.Q[2 * e], ev.Q[2 * e + 1]);
      const ni = nodeOfPin[e];
      // curvature used for the inside/outside label: at the node, or one node in at the ends
      let kap = curv[ni];
      if (e === 0) kap = curv[Math.min(ni + 1, nn - 1)];
      if (e === K) kap = curv[Math.max(ni - 1, 0)];
      o.label = 'outside';
      if (p.mode === 'through') o.label = 'through';
      else if (Math.abs(kap) < 1e-6 / N.Lref) o.label = 'straight';
      else if (p.side * kap > 0) o.label = 'inside';
      const f = ev.phi[e];
      const nx = -Math.sin(f);
      const ny = Math.cos(f);
      const press = pressOf(F[e], f, p.side);
      o.force = Math.hypot(F[e][0], F[e][1]) / Fmax;
      o.forceVec = [F[e][0] / (N.Lref * N.Lref), -F[e][1] / (N.Lref * N.Lref)];
      o.press = press / Fmax;
      if (p.mode !== 'through' && Math.abs(curv[ni]) * this.rEff > 1) o.warnings.push('wrap');
      const end = e === 0 || e === K;
      // held strip: the end pins carry the tension tangentially, by friction
      if (this.hold && end) {
        const ft = Math.abs(F[e][0] * Math.cos(f) + F[e][1] * Math.sin(f));
        const fn = Math.abs(F[e][0] * nx + F[e][1] * ny);
        o.muReq = fn > 0 ? ft / fn : Infinity;
        out.muReq = Math.max(out.muReq, o.muReq);
      }
      if (sided(p) && end && press < -HYST * Fmax) o.warnings.push('liftoff');
    }

    // One result per pin as given, from the results by the pin each acts as.
    // Warnings: 'duplicate' (sameAs: ids) for pins at the same position, which
    // act as one; 'overlap' (overlaps: ids) for pins closer than the pin diameter.
    _userPinResults(byPin) {
      const U = this.userPins;
      const d2 = this.settings.d * this.settings.d;
      const tol2 = this.posTol * this.posTol;
      const out = U.map((u) => {
        const o = Object.assign({}, byPin.get(this._lead(u.id)) || { engaged: false, side: 1 });
        o.id = u.id;
        o.x = u.x;
        o.y = u.y;
        o.mode = u.mode;
        o.warnings = (o.warnings || []).slice();
        return o;
      });
      const flag = (o, w, key, id) => {
        if (!o[key]) {
          o[key] = [];
          o.warnings.push(w);
        }
        o[key].push(id);
      };
      for (let i = 0; i < U.length; i++) {
        for (let j = i + 1; j < U.length; j++) {
          const dx = U[i].x - U[j].x;
          const dy = U[i].y - U[j].y;
          const dd = dx * dx + dy * dy;
          if (!(dd < d2 || dd <= tol2)) continue;
          if (this._lead(U[i].id) === this._lead(U[j].id)) {
            flag(out[i], 'duplicate', 'sameAs', U[j].id);
            flag(out[j], 'duplicate', 'sameAs', U[i].id);
          } else if (dd > tol2) {
            flag(out[i], 'overlap', 'overlaps', U[j].id);
            flag(out[j], 'overlap', 'overlaps', U[i].id);
          }
        }
      }
      return out;
    }

    // Closest point on the strip (between the end contacts) to (x, y), mm.
    // index: where a pin inserted here goes in the sequence.
    locate(px, py) {
      if (!this.prob) return null;
      const sh = this.shape();
      const pr = project(sh.nodes, sh.cum, [px, py], 0, sh.cum[sh.cum.length - 1]);
      const U = this.userPins;
      let index = U.length;
      for (let i = 0; i < U.length; i++) {
        const t = sh.params.get(this._lead(U[i].id));
        if (t !== undefined && t > pr.t) {
          index = i;
          break;
        }
      }
      const q = pointAt(sh.nodes, sh.cum, pr.t);
      const atEnd = pr.t <= 0 || pr.t >= sh.cum[sh.cum.length - 1];
      return { dist: pr.d, t: pr.t, index, point: q, atEnd };
    }

    // Serialisable state (mm), enough to rebuild the same shape. A stale shape,
    // or a failed one that is not the last good shape, is left out: it is no
    // starting point for this layout.
    /** @returns {State} */
    getState() {
      const failedRaw =
        this.status === 'failed' && !(this.lastGood && this.prob === this.lastGood.prob);
      const keep = this.prob && !failedRaw && this.prob.sig === this._signature();
      const sh = keep ? this.shape() : null;
      const byId = new Map(this.pins.map((p) => [p.id, p]));
      return {
        pins: this.userPins.map((u) => {
          const p = byId.get(this._lead(u.id));
          return {
            id: u.id,
            x: u.x,
            y: u.y,
            mode: u.mode,
            side: p ? p.side : 1,
            engaged: p ? p.engaged : true,
          };
        }),
        shape: sh
          ? {
              nodes: sh.nodes.map((q) => [q[0], q[1]]),
              params: Array.from(sh.params.entries()),
              stretches: sh.stretches,
            }
          : null,
      };
    }
    /**
     * Restore a state from getState(), with new settings if given.
     * @param {State} st
     */
    setState(st) {
      if (st.settings) Object.assign(this.settings, st.settings);
      this.pins = this._group(st.pins).map((p) => {
        const mode = p.mode || 'auto';
        const through = mode === 'through';
        return {
          id: p.id,
          x: p.x,
          y: p.y,
          mode,
          side: modeSide(mode, p.side),
          engaged: through || p.engaged !== false,
          flips: 0,
          events: 0,
          marginal: false,
          fresh: !p.side,
        };
      });
      if (this.pins.length) {
        this.pins[0].engaged = true;
        this.pins[this.pins.length - 1].engaged = true;
      }
      const shape = st.shape
        ? {
            nodes: st.shape.nodes,
            params: new Map(st.shape.params),
            stretches: st.shape.stretches,
            cum: cumLen(st.shape.nodes),
          }
        : null;
      this.prob = null;
      this._resetProgress();
      this.hold = false;
      this.nu = 0;
      this._rebuild(shape);
      this._markStart();
    }
  }

  root.SpringSolver = {
    Strip,
    bandLU,
    bandSolve,
    evaluate,
    makeLayout,
    iTh,
    iH,
    MODES: ['auto', 'left', 'right', 'through'],
    consts: { SEG_TARGET, M_MIN, M_MAX, TOL_STEP, TOL_CON, HYST },
    work,
  };
})(typeof window !== 'undefined' ? window : globalThis);
