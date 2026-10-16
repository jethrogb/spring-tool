// Random drag sweep for the solver (src/solver.js): random layouts, one pin
// dragged far in small steps the way the UI does it (also across the strip,
// out of sequence order and through other pins), then left to settle.
// Run: npm run test:sweep   (options: --trials N --seed S --only K --steps-iter I --verbose)
// --save-failures DIR writes each drag that fails to DIR as a JSON case: the
// layout before the drag, the settings and the drag itself. --case FILE
// replays one such case exactly (independent of the random sequence). The
// cases saved in test/fixtures/sweep-cases/ (drags that once failed) are
// replayed on every run as regression cases.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { test } = require('node:test');
const assert = require('node:assert');

const file = path.join(__dirname, '..', 'src', 'solver.js');
vm.runInThisContext(fs.readFileSync(file, 'utf8'), { filename: file });
const S = globalThis.SpringSolver;

const argText = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const arg = (name, def) => {
  const v = argText(name);
  return v === undefined ? def : Number(v);
};
const SAVE_DIR = argText('save-failures');
const CASES_DIR = path.join(__dirname, 'fixtures', 'sweep-cases');
const CASE_FILE = argText('case');
const CASE = CASE_FILE ? JSON.parse(fs.readFileSync(CASE_FILE, 'utf8')) : null;
const TRIALS = CASE ? 1 : arg('trials', 60);
const SEED = arg('seed', 777);
const VERBOSE = process.argv.includes('--verbose');
const ONLY = arg('only', -1); // run just this trial (the random sequence is still advanced)
// Newton iterations per pointer move. A fixed count (instead of the UI's 8 ms
// per frame) makes every run identical on any machine; 0 uses 8 ms like the UI.
const STEP_ITER = arg('steps-iter', CASE ? CASE.drag.iterationsPerMove : 3);

const DRAG_STEPS = 60; // pointer moves per drag
const FRAME_MS = 8; // solver budget per move, as in the UI's animation frame
const HOLD_FACTOR = 2; // length limit, × the summed pin-to-pin distances
const MAX_SETTLE_ITER = 1000; // Newton iterations allowed after the drag ends
const SLOW_ITER = 200; // settling slower than this is listed

let seed = SEED;
function rnd() {
  seed = (seed * 16807) % 2147483647;
  return seed / 2147483647;
}

const finite = (r) =>
  r.nodes.every((q) => Number.isFinite(q[0]) && Number.isFinite(q[1])) && Number.isFinite(r.length);
const lref = (pins) => {
  let L = 0;
  for (let i = 1; i < pins.length; i++) {
    L += Math.hypot(pins[i].x - pins[i - 1].x, pins[i].y - pins[i - 1].y);
  }
  return L;
};
const describe = (pins) =>
  JSON.stringify(pins.map((p) => [Math.round(p.x), Math.round(p.y), p.mode[0]]));

// A layout of 3–12 pins roughly left to right, 15% of them Left/Right, and the drag to make.
function makeTrial() {
  const n = 3 + Math.floor(rnd() * 10);
  const pins = [];
  let x = 0;
  for (let i = 0; i < n; i++) {
    x += 40 + rnd() * 80;
    // draw order matters (the same layouts on every run): y, then the mode
    const y = (rnd() - 0.5) * 100;
    const sided = rnd() < 0.15;
    const left = sided && rnd() < 0.5;
    let mode = 'auto';
    if (sided) mode = left ? 'left' : 'right';
    pins.push({ id: i + 1, x, y, mode });
  }
  const d = 6 + rnd() * 20;
  const k = Math.floor(rnd() * n);
  const dx = (rnd() - 0.5) * 300;
  const dy = (rnd() - 0.5) * 300;
  return { n, pins, d, t: 3, holdFactor: HOLD_FACTOR, k, dx, dy, moves: DRAG_STEPS };
}

// The trial a saved case describes.
function trialFromCase(c) {
  const pins = c.pins.map((p) => ({ ...p }));
  const { d, t, holdFactor } = c.settings;
  const { pin, dx, dy, moves } = c.drag;
  return { n: pins.length, pins, d, t, holdFactor, k: pin - 1, dx, dy, moves };
}

// Write a failing drag to SAVE_DIR: everything needed to replay it.
function saveCase(trial, tr, start, out, problems) {
  fs.mkdirSync(SAVE_DIR, { recursive: true });
  const name = `seed${SEED}-trial${trial}.json`;
  const data = {
    about:
      'A drag from the drag sweep that did not settle on a valid shape. Pins are in mm, y down, before the drag; the drag moves pin `drag.pin` (1-based) by (dx, dy) in `moves` equal steps, with `iterationsPerMove` Newton iterations after each, then lets it settle.',
    replay: `node test/drag-sweep.test.js --case ${path.join(SAVE_DIR, name)}`,
    sweep: {
      seed: SEED,
      trial,
      replay: `node test/drag-sweep.test.js --seed ${SEED} --only ${trial}`,
    },
    settings: { d: tr.d, t: tr.t, holdFactor: tr.holdFactor },
    pins: start,
    drag: { pin: tr.k + 1, dx: tr.dx, dy: tr.dy, moves: tr.moves, iterationsPerMove: STEP_ITER },
    outcome: { status: out.status, problems, iterationsToSettle: out.iter, pinsAfterDrag: tr.pins },
  };
  fs.writeFileSync(path.join(SAVE_DIR, name), `${JSON.stringify(data, null, 2)}\n`);
  console.log(`  saved ${path.join(SAVE_DIR, name)}`);
}

// Drag pin k up to ±150 mm in each direction, then let it settle.
function dragAndSettle(trial, s, stepIter = STEP_ITER) {
  const { pins, k, dx, dy, moves } = trial;
  s.setPins(pins);
  s.solve(5000);
  const x0 = pins[k].x;
  const y0 = pins[k].y;
  let nanAt = -1;
  for (let st = 1; st <= moves; st++) {
    pins[k].x = x0 + (dx * st) / moves;
    pins[k].y = y0 + (dy * st) / moves;
    s.setPins(pins);
    if (stepIter > 0) s.run(0, stepIter);
    else s.run(FRAME_MS);
    if (nanAt < 0 && !finite(s.result())) nanAt = st;
  }
  const ts = Date.now();
  const status = s.solve(20000);
  return { status, nanAt, ms: Date.now() - ts, iter: s.iter, r: s.result() };
}

// Left/Right pins must push. Interior ones are released when they would pull;
// end pins are never released, so they must carry the lift-off warning. An
// interior one may only pull when it is flagged "marginal" (its contact kept
// changing and was frozen, e.g. pins overlapping each other).
function pinProblems(trial, r, counts) {
  const problems = [];
  r.pins.forEach((p, i) => {
    if (!p.engaged || p.mode === 'auto' || !(p.press < -S.consts.HYST)) return;
    const end = i === 0 || i === trial.n - 1;
    if (!end) {
      if (p.warnings.includes('marginal')) counts.marginals++;
      else problems.push(`interior pin ${i + 1} pulls (press ${p.press.toFixed(3)})`);
    } else if (p.warnings.includes('liftoff')) counts.liftoffs++;
    else problems.push(`end pin ${i + 1} pulls without a lift-off warning`);
  });
  return problems;
}

function problemsOf(trial, out, counts) {
  const { status, nanAt, r, iter } = out;
  const problems = [];
  if (nanAt >= 0) problems.push(`non-finite shape at drag step ${nanAt}`);
  const settled = status === 'converged' || status === 'friction';
  if (!settled) problems.push(`ended "${status}"`);
  if (!finite(r)) problems.push('non-finite final shape');
  if (settled) {
    problems.push(...pinProblems(trial, r, counts));
    const limit = trial.holdFactor * lref(trial.pins);
    if (r.length > limit * (1 + 1e-6)) {
      problems.push(`length ${r.length.toFixed(1)} mm exceeds the limit ${limit.toFixed(1)} mm`);
    }
  }
  if (iter > MAX_SETTLE_ITER) problems.push(`took ${iter} iterations to settle`);
  return problems;
}

test('drag sweep: every drag settles on a valid shape without NaN', () => {
  const tally = {};
  const slow = [];
  const counts = { liftoffs: 0, marginals: 0 };
  const failures = [];
  let passes = 0;
  let worstMs = 0;
  let worstIter = 0;
  const t0 = Date.now();
  for (let trial = 0; trial < TRIALS; trial++) {
    const tr = CASE ? trialFromCase(CASE) : makeTrial();
    if (ONLY >= 0 && trial !== ONLY) continue;
    const s = new S.Strip({ d: tr.d, t: tr.t, holdFactor: tr.holdFactor });
    if (ONLY >= 0 || CASE) globalThis.__sweepStrip = s;
    const start = tr.pins.map((p) => ({ ...p })); // the drag moves a pin in place
    const out = dragAndSettle(tr, s);
    tally[out.status] = (tally[out.status] || 0) + 1;
    worstMs = Math.max(worstMs, out.ms);
    worstIter = Math.max(worstIter, out.iter);
    if (out.iter > SLOW_ITER) slow.push(`trial ${trial}: ${out.iter} iterations, ${out.ms} ms`);
    const problems = problemsOf(tr, out, counts);
    if (problems.length) {
      failures.push(...problems);
      if (SAVE_DIR && !CASE) saveCase(trial, tr, start, out, problems);
      console.log(
        `FAIL trial ${trial} (${tr.n} pins, d=${tr.d.toFixed(1)}, dragged pin ${tr.k + 1}): ${problems.join('; ')}\n  pins ${describe(tr.pins)}`,
      );
    } else {
      passes++;
      if (VERBOSE) {
        console.log(`ok   trial ${trial}: ${out.status}, ${out.iter} iterations, ${out.ms} ms`);
      }
    }
  }
  const per = STEP_ITER > 0 ? `${STEP_ITER} iterations` : `${FRAME_MS} ms`;
  const from = CASE ? `case ${CASE_FILE}` : `seed ${SEED}`;
  console.log(
    `\n${TRIALS} drags (${from}, ${per} per move) in ${((Date.now() - t0) / 1000).toFixed(1)} s: ${JSON.stringify(tally)}`,
  );
  console.log(
    `settling: worst ${worstIter} iterations, ${worstMs} ms; flagged: ${counts.liftoffs} Left/Right end pins "would lift off", ${counts.marginals} interior pins "marginal"`,
  );
  if (slow.length) {
    console.log(`slow to settle (>${SLOW_ITER} iterations):\n  ${slow.join('\n  ')}`);
  }
  console.log(
    `${passes} trials passed, ${failures.length ? `${failures.length} problems found` : '0 failed'}`,
  );
  assert.deepStrictEqual(failures, [], `${failures.length} problems found`);
});

// Saved cases: each must now settle on a valid shape, exactly as replayed with --case.
// Skipped when one drag is picked with --case or --only.
test('saved drags settle on a valid shape', { skip: CASE || ONLY >= 0 }, () => {
  const files = fs.existsSync(CASES_DIR)
    ? fs.readdirSync(CASES_DIR).filter((f) => f.endsWith('.json'))
    : [];
  const failures = [];
  for (const f of files.sort()) {
    const c = JSON.parse(fs.readFileSync(path.join(CASES_DIR, f), 'utf8'));
    const tr = trialFromCase(c);
    const s = new S.Strip({ d: tr.d, t: tr.t, holdFactor: tr.holdFactor });
    const out = dragAndSettle(tr, s, c.drag.iterationsPerMove);
    const problems = problemsOf(tr, out, { liftoffs: 0, marginals: 0 });
    if (problems.length) failures.push(`${f}: ${problems.join('; ')}`);
    console.log(`${problems.length ? 'FAIL' : 'ok  '} ${f}: ${out.status}, ${out.iter} iterations`);
  }
  console.log(`${files.length} saved drags replayed, ${failures.length} failed`);
  assert.ok(files.length > 0, `no saved drags in ${CASES_DIR}`);
  assert.deepStrictEqual(failures, [], `${failures.length} saved drags failed`);
});
