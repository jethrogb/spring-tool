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
 */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const svg = $('view');
  const RULER_T = 22;
  const RULER_L = 40; // ruler sizes, px
  const HIT_PX = 8; // insertion / hover distance, px
  const HANDLE_PX = 11; // pin handle radius, px
  const DEFAULTS = { W: 600, H: 400, d: 6, t: 3, overhang: 20, minR: 0, holdFactor: 2 };
  const STORE_KEY = 'springStripJig.v1';
  const EXAMPLE = {
    W: 600,
    H: 400,
    pins: [
      [60, 300],
      [170, 205],
      [300, 175],
      [420, 235],
      [540, 140],
    ],
  };
  const DEFAULT_MODE = 'through'; // mode of new pins and of the example
  const WHEEL_UNIT_PX = [1, 16, 400]; // a wheel step in px, by deltaMode (pixels, lines, pages)
  const MODES = ['through', 'auto', 'left', 'right']; // the order X cycles through
  const UNDO_LIMIT = 300; // undo steps kept
  const AUTOSAVE_MS = 300; // the project is saved this long after the last change
  const CONTEXT_GRACE_MS = 400; // the context menu right after a right-button pan deletes nothing
  const DBLCLICK_GRACE_MS = 600; // a double-click on a pin just made does not change its mode

  const state = { settings: Object.assign({}, DEFAULTS), pins: [], nextId: 1, selected: null };
  const solver = new SpringSolver.Strip(solverSettings());
  const view = { z: 1, tx: 0, ty: 0, w: 0, h: 0 };
  let grid = { minor: 1, major: 10 };
  let res = solver.result();
  let hover = null; // {sx, sy, wx, wy}
  let drag = null;
  let pinsDirty = false;
  let lastCreated = { id: null, time: 0 };

  function solverSettings() {
    const s = state.settings;
    return { d: s.d, t: s.t, holdFactor: s.holdFactor };
  }

  // ------------------------------------------------------------ formatting
  function fmtNum(v, dec) {
    const neg = v < 0;
    const s = Math.abs(v).toFixed(dec);
    let [i, f] = s.split('.');
    if (i.length > 3) i = i.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
    if (f) {
      f = f.replace(/0+$/, '');
    }
    return (neg ? '−' : '') + i + (f ? `.${f}` : '');
  }
  function fmtLen(v) {
    if (!Number.isFinite(v)) return '∞';
    const a = Math.abs(v);
    const dec = a === 0 ? 0 : Math.min(3, Math.max(0, 3 - Math.floor(Math.log10(a))));
    return `${fmtNum(v, dec)} mm`;
  }
  function fmtCoord(v) {
    const dec = Math.min(6, Math.max(0, Math.ceil(Math.log10(Math.max(view.z, 1e-9))) + 1));
    return fmtNum(v, dec);
  }
  function clean(v) {
    return Number(v.toPrecision(12));
  }

  // ---------------------------------------------------------------- view
  function w2s(x, y) {
    return [x * view.z + view.tx, y * view.z + view.ty];
  }
  function s2w(x, y) {
    return [(x - view.tx) / view.z, (y - view.ty) / view.z];
  }
  function localXY(e) {
    const r = svg.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }
  function measure() {
    const r = svg.getBoundingClientRect();
    view.w = r.width;
    view.h = r.height;
  }

  // The view showing the box; applied unless apply === false.
  function fitBox([x0, y0, x1, y1], pad, apply) {
    measure();
    const aw = Math.max(view.w - RULER_L - 2 * pad, 20);
    const ah = Math.max(view.h - RULER_T - 2 * pad - 26, 20);
    const bw = Math.max(x1 - x0, 1e-9);
    const bh = Math.max(y1 - y0, 1e-9);
    const z = Math.min(aw / bw, ah / bh);
    const v = {
      z,
      tx: RULER_L + pad + (aw - bw * z) / 2 - x0 * z,
      ty: RULER_T + pad + 26 + (ah - bh * z) / 2 - y0 * z,
    };
    if (apply !== false) {
      Object.assign(view, v);
      requestRender();
    }
    return v;
  }
  function fitArea(apply) {
    return fitBox([0, 0, state.settings.W, state.settings.H], 36, apply);
  }
  // F: fit the work area, or the pins if the work area is already fitted.
  function fitToggle() {
    const v = fitArea(false);
    const same =
      Math.abs(view.z / v.z - 1) < 1e-6 &&
      Math.abs(view.tx - v.tx) < 0.5 &&
      Math.abs(view.ty - v.ty) < 0.5;
    if (same && state.pins.length) fitPins();
    else fitArea();
  }
  function fitPins() {
    if (state.pins.length < 2 && !(res.nodes && res.nodes.length)) {
      fitArea();
      return;
    }
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    const add = (x, y) => {
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    };
    for (const p of state.pins) add(p.x, p.y);
    if (res.nodes) for (const q of res.nodes) add(q[0], q[1]);
    const m = Math.max(state.settings.d, 0.02 * Math.max(x1 - x0, y1 - y0));
    fitBox([x0 - m, y0 - m, x1 + m, y1 + m], 30);
  }
  function zoomAt(sx, sy, k) {
    const nz = Math.min(1e6, Math.max(1e-6, view.z * k));
    const f = nz / view.z;
    view.tx = sx - (sx - view.tx) * f;
    view.ty = sy - (sy - view.ty) * f;
    view.z = nz;
    requestRender();
  }
  // Minor step: smallest 1, 2 or 5 × 10^n mm that is at least 8 px.
  function computeGrid() {
    const target = 8 / view.z;
    const e = Math.floor(Math.log10(target));
    let minor = null;
    for (const ee of [e, e + 1]) {
      for (const m of [1, 2, 5]) {
        const v = m * Math.pow(10, ee);
        if (minor === null && v >= target * (1 - 1e-9)) minor = v;
      }
    }
    const mant = Math.round(minor / Math.pow(10, Math.floor(Math.log10(minor) + 1e-9)));
    const major = minor * (mant === 2 ? 5 : 10);
    grid = { minor: clean(minor), major: clean(major) };
  }
  function niceAtLeast(v) {
    const e = Math.floor(Math.log10(v));
    for (const ee of [e, e + 1]) {
      for (const m of [1, 2, 5]) {
        const c = m * Math.pow(10, ee);
        if (c >= v * (1 - 1e-9)) return clean(c);
      }
    }
    return v;
  }

  // ---------------------------------------------------------------- solver loop
  let rafPending = false;
  function requestRender() {
    if (!rafPending) {
      rafPending = true;
      requestAnimationFrame(frame);
    }
  }
  // Show "converging" on the page background, but only once a solve has run
  // for a moment, so the quick re-solves while dragging do not flicker.
  const BUSY_DELAY_MS = 200;
  let busySince = null;
  function showBusy(converging) {
    const now = performance.now();
    if (!converging) busySince = null;
    else if (busySince === null) busySince = now;
    $('stage').classList.toggle('converging', converging && now - busySince >= BUSY_DELAY_MS);
  }
  // promises waiting for the solver to go quiet (test hook whenIdle)
  const idleWaiters = [];
  function frame() {
    rafPending = false;
    if (pinsDirty) {
      solver.setPins(state.pins);
      pinsDirty = false;
    }
    const active = solver.run(8);
    res = solver.result();
    render();
    showBusy(res.status === 'converging');
    if (active) requestRender();
    else if (!rafPending) for (const w of idleWaiters.splice(0)) w(res.status);
  }
  function pinsChanged() {
    pinsDirty = true;
    requestRender();
  }

  // ---------------------------------------------------------------- undo / save
  const undoStack = [];
  const redoStack = [];
  let pendingUndo = null;
  function snapshot() {
    if (pinsDirty) {
      solver.setPins(state.pins);
      pinsDirty = false;
    }
    const st = solver.getState();
    return JSON.stringify({
      v: 1,
      settings: state.settings,
      nextId: state.nextId,
      selected: state.selected,
      pins: st.pins,
      shape: st.shape,
    });
  }
  // Settings rules, shared by the Settings fields and by opening a project.
  const SETTING_OK = {
    W: (v) => v > 0,
    H: (v) => v > 0,
    d: (v) => v > 0,
    t: (v) => v > 0,
    overhang: (v) => v >= 0,
    minR: (v) => v >= 0,
    holdFactor: (v) => v > 1,
  };
  function validSetting(k, v) {
    return typeof v === 'number' && Number.isFinite(v) && SETTING_OK[k](v);
  }
  // A project as read from a file or from storage: {project, problems}.
  // Problems would change the design (a pin without a position, an unknown
  // mode, a bad setting, a newer format): opening a file refuses them, and
  // restoring leaves those parts out. Repaired quietly: numbers written as
  // text, missing or repeated pin ids, and a bad saved shape (it is only a
  // starting point for the solver).
  function checkProject(o) {
    const problems = [];
    if (!o || typeof o !== 'object') {
      return {
        project: { v: 1, settings: {}, nextId: 1, selected: null, pins: [], shape: null },
        problems: ['the project data is not valid'],
      };
    }
    if (o.v !== undefined && o.v !== 1) {
      problems.push(
        `it was made by a newer version of this tool (format ${String(o.v).slice(0, 10)})`,
      );
    }
    const num = (v) => {
      if (typeof v === 'number') return v;
      return typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
    };
    const settings = {};
    const given = o.settings && typeof o.settings === 'object' ? o.settings : {};
    for (const k of Object.keys(DEFAULTS)) {
      if (given[k] === undefined) continue;
      const v = num(given[k]);
      if (validSetting(k, v)) settings[k] = v;
      else problems.push(`the setting ${k} is not valid ("${String(given[k]).slice(0, 20)}")`);
    }
    if (!Array.isArray(o.pins)) problems.push('it has no list of pins');
    const pins = [];
    (Array.isArray(o.pins) ? o.pins : []).forEach((p, i) => {
      const x = num(p && p.x);
      const y = num(p && p.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        problems.push(`pin ${i + 1} has no valid position`);
        return;
      }
      const mode = p.mode === undefined ? 'auto' : p.mode;
      if (!MODES.includes(mode)) {
        problems.push(`pin ${i + 1} has an unknown mode "${String(mode).slice(0, 20)}"`);
        return;
      }
      const q = { id: p.id, x, y, mode };
      if (p.side === 1 || p.side === -1 || p.side === 0) q.side = p.side;
      if (typeof p.engaged === 'boolean') q.engaged = p.engaged;
      pins.push(q);
    });
    // ids: unique positive integers, or all renumbered (the saved shape refers to the old ones)
    const idsOk =
      new Set(pins.map((p) => p.id)).size === pins.length &&
      pins.every((p) => Number.isInteger(p.id) && p.id > 0);
    if (!idsOk) {
      pins.forEach((p, i) => {
        p.id = i + 1;
      });
    }
    const maxId = pins.reduce((m, p) => Math.max(m, p.id), 0);
    return {
      project: {
        v: 1,
        settings,
        pins,
        nextId: Math.max(Number.isInteger(o.nextId) && o.nextId > 0 ? o.nextId : 1, maxId + 1),
        selected: idsOk && pins.some((p) => p.id === o.selected) ? o.selected : null,
        shape: idsOk && validShape(o.shape) ? o.shape : null,
      },
      problems,
    };
  }
  function validShape(sh) {
    const fin = (v) => typeof v === 'number' && Number.isFinite(v);
    const pair = (q) => Array.isArray(q) && q.length === 2 && fin(q[0]) && fin(q[1]);
    const { M_MIN, M_MAX } = SpringSolver.consts;
    return (
      Boolean(sh) &&
      Array.isArray(sh.nodes) &&
      sh.nodes.length >= 2 &&
      sh.nodes.every(pair) &&
      Array.isArray(sh.params) &&
      sh.params.every((e) => Array.isArray(e) && e.length === 2 && fin(e[1])) &&
      Array.isArray(sh.stretches) &&
      sh.stretches.every(
        (s) =>
          s &&
          fin(s.t0) &&
          fin(s.t1) &&
          Number.isInteger(s.m) &&
          s.m >= M_MIN &&
          s.m <= M_MAX &&
          pair(s.lam),
      )
    );
  }
  function restore(json) {
    const o = checkProject(typeof json === 'string' ? JSON.parse(json) : json).project;
    state.settings = Object.assign({}, DEFAULTS, o.settings);
    state.pins = o.pins.map((p) => ({ id: p.id, x: p.x, y: p.y, mode: p.mode }));
    state.nextId = o.nextId;
    state.selected = o.selected;
    solver.setState({ pins: o.pins, shape: o.shape, settings: solverSettings() });
    pinsDirty = false;
    syncInputs();
    requestRender();
  }
  function beginChange() {
    pendingUndo = snapshot();
  }
  function commitChange() {
    if (pendingUndo === null) return;
    undoStack.push(pendingUndo);
    if (undoStack.length > UNDO_LIMIT) undoStack.shift();
    redoStack.length = 0;
    pendingUndo = null;
    historyChanged();
  }
  function cancelChange() {
    pendingUndo = null;
  }
  function change(fn) {
    beginChange();
    fn();
    commitChange();
  }
  function undo() {
    if (!undoStack.length) return;
    redoStack.push(snapshot());
    restore(undoStack.pop());
    historyChanged();
  }
  function redo() {
    if (!redoStack.length) return;
    undoStack.push(snapshot());
    restore(redoStack.pop());
    historyChanged();
  }
  // the undo history changed: save the project, update the Undo and Redo buttons
  function historyChanged() {
    autosave();
    updateButtons();
  }
  let saveTimer = null;
  function autosave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        localStorage.setItem(STORE_KEY, snapshot());
      } catch {
        /* storage unavailable */
      }
    }, AUTOSAVE_MS);
  }
  function updateButtons() {
    $('btnUndo').disabled = !undoStack.length;
    $('btnRedo').disabled = !redoStack.length;
  }

  // ---------------------------------------------------------------- pins
  function pinIndex(id) {
    return state.pins.findIndex((p) => p.id === id);
  }
  function getPin(id) {
    return state.pins.find((p) => p.id === id) || null;
  }
  function snap(v, e) {
    if (e && e.altKey) return clean(v);
    const s = grid.minor;
    return clean(Math.round(v / s) * s);
  }
  function pinAt(sx, sy) {
    let best = null;
    let bd = Infinity;
    const rp = Math.max(HANDLE_PX, (state.settings.d / 2) * view.z);
    for (const p of state.pins) {
      const q = w2s(p.x, p.y);
      const d = Math.hypot(q[0] - sx, q[1] - sy);
      if (d <= rp && d < bd) {
        bd = d;
        best = p;
      }
    }
    return best;
  }
  function insertionFor(wx, wy) {
    const n = state.pins.length;
    if (n === 0) return { index: 0, kind: 'first' };
    if (n >= 2) {
      const loc = solver.locate(wx, wy); // null while there is no strip
      if (loc && !loc.atEnd && loc.dist * view.z <= HIT_PX) {
        return { index: loc.index, kind: 'strip', point: loc.point };
      }
    }
    const a = state.pins[0];
    const b = state.pins[n - 1];
    if (n >= 2 && Math.hypot(wx - a.x, wy - a.y) < Math.hypot(wx - b.x, wy - b.y)) {
      return { index: 0, kind: 'end', from: a };
    }
    return { index: n, kind: 'end', from: b };
  }
  function addPinAt(wx, wy, e) {
    const ins = insertionFor(wx, wy);
    const p = { id: state.nextId++, x: snap(wx, e), y: snap(wy, e), mode: DEFAULT_MODE };
    state.pins.splice(ins.index, 0, p);
    state.selected = p.id;
    lastCreated = { id: p.id, time: performance.now() };
    pinsChanged();
    return p;
  }
  function removePin(id) {
    const i = pinIndex(id);
    if (i < 0) return;
    change(() => {
      state.pins.splice(i, 1);
      if (state.selected === id) state.selected = null;
      pinsChanged();
    });
  }
  function setMode(id, mode) {
    const p = getPin(id);
    if (!p || p.mode === mode) return;
    change(() => {
      p.mode = mode;
      pinsChanged();
    });
  }
  function cycleMode(id) {
    const p = getPin(id);
    if (p) setMode(id, MODES[(MODES.indexOf(p.mode) + 1) % MODES.length]);
  }
  function nudge(dx, dy) {
    const p = getPin(state.selected);
    if (!p) return;
    change(() => {
      p.x = clean(p.x + dx);
      p.y = clean(p.y + dy);
      pinsChanged();
    });
  }

  // ---------------------------------------------------------------- pointer input
  const pointers = new Map();
  let suppressContextUntil = 0; // see the contextmenu handler
  function inRulers(sx, sy) {
    return sx < RULER_L || sy < RULER_T;
  }

  svg.addEventListener('pointerdown', (e) => {
    const [sx, sy] = localXY(e);
    try {
      svg.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    pointers.set(e.pointerId, { x: sx, y: sy });
    if (pointers.size === 2) {
      // second finger: abandon any pin gesture and pinch instead
      if (drag && drag.type === 'pin' && (drag.created || drag.moved) && pendingUndo) {
        const u = pendingUndo;
        pendingUndo = null;
        restore(u);
      } else cancelChange();
      const [a, b] = [...pointers.values()];
      drag = {
        type: 'pinch',
        d0: Math.hypot(a.x - b.x, a.y - b.y),
        mx: (a.x + b.x) / 2,
        my: (a.y + b.y) / 2,
      };
      return;
    }
    if (pointers.size > 2) return;
    // pressing on the drawing ends any edit in the panel, so keys reach the drawing
    const ae = document.activeElement;
    if (ae && ae !== document.body && ae.blur && pointers.size === 1) ae.blur();
    // pan: middle button, right button on empty space, or a ruler
    const rightPan = e.button === 2 && !pinAt(sx, sy);
    if (e.button === 1 || rightPan || (e.button === 0 && inRulers(sx, sy))) {
      e.preventDefault();
      drag = { type: 'pan', sx, sy, tx: view.tx, ty: view.ty, moved: false };
      svg.classList.add('panning');
      return;
    }
    if (e.button !== 0) return;
    const [wx, wy] = s2w(sx, sy);
    const pin = pinAt(sx, sy);
    beginChange();
    if (pin) {
      state.selected = pin.id;
      drag = {
        type: 'pin',
        id: pin.id,
        offX: pin.x - wx,
        offY: pin.y - wy,
        sx,
        sy,
        moved: false,
        created: false,
      };
    } else {
      const p = addPinAt(wx, wy, e);
      drag = {
        type: 'pin',
        id: p.id,
        offX: p.x - wx,
        offY: p.y - wy,
        sx,
        sy,
        moved: false,
        created: true,
      };
    }
    hover = null;
    syncPinInputs();
    requestRender();
  });

  svg.addEventListener('pointermove', (e) => {
    const [sx, sy] = localXY(e);
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: sx, y: sy });
    const [wx, wy] = s2w(sx, sy);
    $('cursor').textContent = `X ${fmtCoord(wx)}  Y ${fmtCoord(wy)} mm`;
    if (drag && drag.type === 'pinch' && pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      view.tx += mx - drag.mx;
      view.ty += my - drag.my;
      if (drag.d0 > 0 && d > 0) zoomAt(mx, my, d / drag.d0);
      drag.d0 = d;
      drag.mx = mx;
      drag.my = my;
      requestRender();
      return;
    }
    if (drag && drag.type === 'pan') {
      if (Math.hypot(sx - drag.sx, sy - drag.sy) >= 3) drag.moved = true;
      view.tx = drag.tx + sx - drag.sx;
      view.ty = drag.ty + sy - drag.sy;
      requestRender();
      return;
    }
    if (drag && drag.type === 'pin') {
      if (!drag.moved && !drag.created && Math.hypot(sx - drag.sx, sy - drag.sy) < 3) return;
      drag.moved = true;
      const p = getPin(drag.id);
      if (p) {
        const nx = snap(wx + drag.offX, e);
        const ny = snap(wy + drag.offY, e);
        if (nx !== p.x || ny !== p.y) {
          p.x = nx;
          p.y = ny;
          pinsChanged();
          syncPinInputs();
        }
      }
      return;
    }
    if (!pointers.size) {
      hover = { sx, sy, wx, wy, alt: e.altKey };
      svg.classList.toggle('overpin', Boolean(pinAt(sx, sy)));
      requestRender();
    }
  });

  function endPointer(e) {
    pointers.delete(e.pointerId);
    if (!drag) return;
    if (drag.type === 'pinch') {
      if (pointers.size === 0) drag = null;
      return;
    }
    if (drag.type === 'pan') {
      // on Windows the context menu event follows the release: do not let a
      // right-button pan that ends over a pin delete it
      if (drag.moved) suppressContextUntil = performance.now() + CONTEXT_GRACE_MS;
      drag = null;
      svg.classList.remove('panning');
      return;
    }
    if (drag.type === 'pin') {
      if (drag.created || drag.moved) commitChange();
      else cancelChange();
      drag = null;
      autosave();
    }
  }
  svg.addEventListener('pointerup', endPointer);
  svg.addEventListener('pointercancel', endPointer);
  svg.addEventListener('pointerleave', () => {
    if (!pointers.size) {
      hover = null;
      requestRender();
    }
  });

  svg.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if ((drag && drag.type === 'pan' && drag.moved) || performance.now() < suppressContextUntil) {
      return;
    }
    const [sx, sy] = localXY(e);
    const p = pinAt(sx, sy);
    if (p) removePin(p.id);
  });
  // stop middle-button autoscroll (Windows, Firefox) and middle-click paste
  svg.addEventListener('mousedown', (e) => {
    if (e.button === 1) e.preventDefault();
  });
  svg.addEventListener('auxclick', (e) => {
    if (e.button === 1) e.preventDefault();
  });
  svg.addEventListener('dblclick', (e) => {
    const [sx, sy] = localXY(e);
    const p = pinAt(sx, sy);
    if (!p) return;
    if (p.id === lastCreated.id && performance.now() - lastCreated.time < DBLCLICK_GRACE_MS) return;
    cycleMode(p.id);
  });
  svg.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const [sx, sy] = localXY(e);
      const unit = WHEEL_UNIT_PX[e.deltaMode] || 1;
      zoomAt(sx, sy, Math.exp(-e.deltaY * unit * 0.0015));
    },
    { passive: false },
  );

  // Typing in a text or number field: keys go to the field.
  function isTyping(target) {
    const tag = (target && target.tagName) || '';
    const type = (target && target.type) || '';
    return (
      tag === 'TEXTAREA' ||
      tag === 'SELECT' ||
      (tag === 'INPUT' && type !== 'checkbox' && type !== 'file')
    );
  }
  // Ctrl/Cmd+Z undoes, with Shift (or Ctrl/Cmd+Y) redoes; left to a field
  // being typed in. Returns true for these keys.
  function undoKey(e, typing) {
    const k = e.key.toLowerCase();
    if (!(e.ctrlKey || e.metaKey) || (k !== 'z' && k !== 'y')) return false;
    if (typing) return true;
    e.preventDefault();
    if (k === 'y' || e.shiftKey) redo();
    else undo();
    return true;
  }
  const MODE_KEYS = new Map([
    ['x', (id) => cycleMode(id)],
    ['a', (id) => setMode(id, 'auto')],
    ['t', (id) => setMode(id, 'through')],
  ]);
  const NUDGE_KEYS = {
    ArrowLeft: [-1, 0],
    ArrowRight: [1, 0],
    ArrowUp: [0, -1],
    ArrowDown: [0, 1],
  };
  // Keys for the selected pin: delete it, set its mode, nudge it a grid step
  // (Shift: a major step).
  function pinKey(e) {
    const id = state.selected;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      removePin(id);
      return;
    }
    const setModeKey = MODE_KEYS.get(e.key.toLowerCase());
    if (setModeKey) {
      setModeKey(id);
      return;
    }
    const dir = Object.hasOwn(NUDGE_KEYS, e.key) ? NUDGE_KEYS[e.key] : null;
    if (dir) {
      e.preventDefault();
      const step = e.shiftKey ? grid.major : grid.minor;
      nudge(dir[0] * step, dir[1] * step);
    }
  }
  window.addEventListener('keydown', (e) => {
    const typing = isTyping(e.target);
    if (undoKey(e, typing)) return;
    if (typing) {
      if (e.key === 'Escape') e.target.blur();
      return;
    }
    if (e.key === 'Escape') {
      state.selected = null;
      syncPinInputs();
      requestRender();
    } else if (e.key.toLowerCase() === 'f') fitToggle();
    else if (state.selected !== null) pinKey(e);
  });
  window.addEventListener('resize', () => requestRender());

  // ---------------------------------------------------------------- panel
  const settingInputs = {
    inW: 'W',
    inH: 'H',
    inD: 'd',
    inT: 't',
    inO: 'overhang',
    inR: 'minR',
    inHold: 'holdFactor',
  };
  function syncInputs() {
    // a minimum bend radius of 0 is shown as an empty field with the placeholder "off"
    const shown = (k) => (k === 'minR' && !state.settings.minR ? '' : state.settings[k]);
    for (const [id, k] of Object.entries(settingInputs)) {
      if (document.activeElement !== $(id)) $(id).value = shown(k);
    }
    syncPinInputs();
    updateButtons();
  }
  for (const [id, k] of Object.entries(settingInputs)) {
    $(id).addEventListener('change', () => {
      const raw = $(id).value.trim();
      const v = k === 'minR' && raw === '' ? 0 : parseFloat(raw); // an empty minimum radius = off
      if (!validSetting(k, v) || v === state.settings[k]) {
        $(id).value = k === 'minR' && !state.settings.minR ? '' : state.settings[k];
        return;
      }
      change(() => {
        state.settings[k] = v;
        if (k === 'd' || k === 't' || k === 'holdFactor') solver.setSettings(solverSettings());
      });
      if (k === 'minR' && !v) $(id).value = '';
      requestRender();
    });
  }
  // The Selected pin box always shows all its fields; they are disabled when
  // no pin is selected, so nothing moves when the selection changes.
  function syncPinInputs() {
    const p = getPin(state.selected);
    for (const id of ['inPX', 'inPY', 'mThrough', 'mAuto', 'mLeft', 'mRight', 'btnDel']) {
      $(id).disabled = !p;
    }
    $('pinName').textContent = p ? `Pin ${pinIndex(p.id) + 1}` : 'No pin selected';
    if (!p) {
      $('inPX').value = '';
      $('inPY').value = '';
      $('pinInfo').textContent = 'Click a pin to select it';
      $('pinInfoTip').classList.add('off');
    } else {
      if (document.activeElement !== $('inPX')) $('inPX').value = p.x;
      if (document.activeElement !== $('inPY')) $('inPY').value = p.y;
    }
    for (const [id, m] of [
      ['mThrough', 'through'],
      ['mAuto', 'auto'],
      ['mLeft', 'left'],
      ['mRight', 'right'],
    ]) {
      $(id).classList.toggle('on', Boolean(p) && p.mode === m);
    }
  }
  for (const [id, k] of [
    ['inPX', 'x'],
    ['inPY', 'y'],
  ]) {
    $(id).addEventListener('change', () => {
      const p = getPin(state.selected);
      const v = parseFloat($(id).value);
      if (!p || !Number.isFinite(v)) {
        syncPinInputs();
        return;
      }
      change(() => {
        p[k] = v;
        pinsChanged();
      });
    });
  }
  $('mAuto').addEventListener('click', () => setMode(state.selected, 'auto'));
  $('mLeft').addEventListener('click', () => setMode(state.selected, 'left'));
  $('mRight').addEventListener('click', () => setMode(state.selected, 'right'));
  $('mThrough').addEventListener('click', () => setMode(state.selected, 'through'));
  $('btnDel').addEventListener('click', () => removePin(state.selected));
  $('btnFit').addEventListener('click', () => fitArea());
  $('btnFitPins').addEventListener('click', () => fitPins());
  $('btnUndo').addEventListener('click', () => undo());
  $('btnRedo').addEventListener('click', () => redo());
  $('btnClear').addEventListener('click', () => {
    if (!state.pins.length) return;
    change(() => {
      state.pins = [];
      state.selected = null;
      pinsChanged();
    });
  });
  $('btnExample').addEventListener('click', () => {
    change(() => loadExample());
    fitArea();
  });
  $('btnExport').addEventListener('click', () => exportSVG());
  $('btnOpen').addEventListener('click', () => $('fileOpen').click());
  function ioMessage(text, ok) {
    $('ioMsg').textContent = text;
    $('ioMsg').title = text;
    $('ioMsg').className = `hint oneline ${ok ? 'ok' : 'bad'}`;
  }
  // Open an SVG saved by this tool, or a TSV coordinate list (told apart by content).
  function openText(name, text) {
    try {
      if (/^\s*</.test(text)) {
        const proj = parseProject(text);
        const { problems } = checkProject(proj);
        if (problems.length) {
          throw new Error(
            problems[0] +
              (problems.length > 1
                ? ` (and ${problems.length - 1} more problem${problems.length > 2 ? 's' : ''})`
                : ''),
          );
        }
        beginChange();
        restore(proj);
        commitChange();
        fitArea();
        ioMessage(`Opened ${name}: ${proj.pins.length} pins`, true);
      } else {
        const pins = parseTSV(text);
        change(() => {
          state.pins = pins.map((p) => ({ id: state.nextId++, x: p.x, y: p.y, mode: p.mode }));
          state.selected = null;
          solver.setState({ pins: state.pins.map((p) => Object.assign({}, p)), shape: null });
          syncInputs();
        });
        requestRender();
        fitPins();
        ioMessage(`Opened ${name}: ${pins.length} pins`, true);
      }
    } catch (err) {
      ioMessage(`Could not open ${name}: ${err.message}`, false);
    }
  }
  $('fileOpen').addEventListener('change', async () => {
    const f = $('fileOpen').files[0];
    $('fileOpen').value = '';
    if (f) openText(f.name, await f.text());
  });
  $('btnExportTsv').addEventListener('click', () =>
    download(buildTSV(), 'spring-strip-pins.tsv', 'text/tab-separated-values'),
  );

  function loadExample() {
    state.settings.W = EXAMPLE.W;
    state.settings.H = EXAMPLE.H;
    state.pins = EXAMPLE.pins.map(([x, y]) => ({ id: state.nextId++, x, y, mode: DEFAULT_MODE }));
    state.selected = null;
    solver.setState({ pins: state.pins.map((p) => Object.assign({}, p)), shape: null });
    syncInputs();
    requestRender();
  }

  // ---------------------------------------------------------------- background image
  // A picture to trace over. Not part of the project: not exported, not in the
  // undo history; remembered in this browser when it fits in local storage.
  const BG_KEY = 'springStripJig.background';
  let bg = { url: null, name: '', opacity: 0.5 };
  try {
    const b = JSON.parse(localStorage.getItem(BG_KEY) || 'null');
    if (b && typeof b.url === 'string') bg = Object.assign(bg, b);
  } catch {
    /* none */
  }
  function saveBg() {
    try {
      if (bg.url) localStorage.setItem(BG_KEY, JSON.stringify(bg));
      else localStorage.removeItem(BG_KEY);
      return true;
    } catch {
      try {
        localStorage.removeItem(BG_KEY);
      } catch {
        /* ignore */
      }
      return false;
    }
  }
  function applyBg() {
    const im = $('bgimg');
    if (bg.url) {
      im.setAttribute('href', bg.url);
      im.style.display = '';
    } else {
      im.removeAttribute('href');
      im.style.display = 'none';
    }
    im.setAttribute('opacity', bg.opacity);
    $('btnBgRemove').disabled = !bg.url;
    $('inBgOpacity').disabled = !bg.url;
    $('btnBgRemove').title = bg.url ? `Remove ${bg.name}` : '';
    $('inBgOpacity').value = bg.opacity;
    $('bgOpacityVal').textContent = `${Math.round(bg.opacity * 100)}%`;
  }
  $('btnBg').addEventListener('click', () => $('fileBg').click());
  $('fileBg').addEventListener('change', () => {
    const f = $('fileBg').files[0];
    $('fileBg').value = '';
    if (!f) return;
    const rd = new FileReader();
    rd.onload = () => {
      const url = String(rd.result);
      const test = new Image();
      // shown only if it really is an image; kept for the next visit if it fits in storage
      test.onload = () => {
        bg.url = url;
        bg.name = f.name;
        saveBg();
        applyBg();
      };
      test.src = url;
    };
    rd.readAsDataURL(f);
  });
  $('btnBgRemove').addEventListener('click', () => {
    bg.url = null;
    bg.name = '';
    saveBg();
    applyBg();
  });
  $('inBgOpacity').addEventListener('input', () => {
    bg.opacity = Number($('inBgOpacity').value);
    $('bgimg').setAttribute('opacity', bg.opacity);
    $('bgOpacityVal').textContent = `${Math.round(bg.opacity * 100)}%`;
  });
  $('inBgOpacity').addEventListener('change', () => saveBg());
  applyBg();

  // ---------------------------------------------------------------- geometry for drawing
  // Centreline with overhangs: [{x, y, dx, dy, k}] (unit tangent, signed curvature 1/mm).
  function fullLine(r, overhang) {
    const n = r.nodes.length;
    if (n < 2) return [];
    const out = [];
    const d0 = [Math.cos(r.tangents[0]), Math.sin(r.tangents[0])];
    const d1 = [Math.cos(r.tangents[n - 1]), Math.sin(r.tangents[n - 1])];
    if (overhang > 0) {
      out.push({
        x: r.nodes[0][0] - d0[0] * overhang,
        y: r.nodes[0][1] - d0[1] * overhang,
        dx: d0[0],
        dy: d0[1],
        k: 0,
      });
    }
    for (let i = 0; i < n; i++) {
      out.push({
        x: r.nodes[i][0],
        y: r.nodes[i][1],
        dx: Math.cos(r.tangents[i]),
        dy: Math.sin(r.tangents[i]),
        k: r.curvature[i],
      });
    }
    if (overhang > 0) {
      out.push({
        x: r.nodes[n - 1][0] + d1[0] * overhang,
        y: r.nodes[n - 1][1] + d1[1] * overhang,
        dx: d1[0],
        dy: d1[1],
        k: 0,
      });
    }
    return out;
  }
  // Cubic Bézier path through points with given unit tangents. off: normal offset.
  function bezierPath(L, off, f, reverse, move) {
    const pts = L.map((p) => ({ x: p.x + off * p.dy, y: p.y - off * p.dx, dx: p.dx, dy: p.dy }));
    if (reverse) pts.reverse();
    const sg = reverse ? -1 : 1;
    let s = `${(move ? 'M' : 'L') + f(pts[0].x)} ${f(pts[0].y)}`;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      const c = Math.hypot(b.x - a.x, b.y - a.y) / 3;
      s += `C${f(a.x + sg * a.dx * c)} ${f(a.y + sg * a.dy * c)} ${f(b.x - sg * b.dx * c)} ${f(
        b.y - sg * b.dy * c,
      )} ${f(b.x)} ${f(b.y)}`;
    }
    return s;
  }
  function bandPath(L, half, f) {
    return `${bezierPath(L, half, f, false, true) + bezierPath(L, -half, f, true, false)}Z`;
  }
  function tightRuns(L, minR) {
    if (!(minR > 0)) return [];
    const kl = 1 / minR;
    const runs = [];
    let cur = null;
    for (let i = 1; i < L.length; i++) {
      const bad = Math.abs(L[i - 1].k) > kl || Math.abs(L[i].k) > kl;
      if (bad) {
        if (!cur) {
          cur = [L[i - 1]];
          runs.push(cur);
        }
        cur.push(L[i]);
      } else cur = null;
    }
    return runs;
  }

  // ---------------------------------------------------------------- render
  const LABEL_COLOUR = { inside: 'var(--inside)', outside: 'var(--outside)' }; // otherwise straight
  // A pin's handle ring and number tag: the ring shows the selection first, the tag the warning first.
  function pinLook(sel, warn) {
    const look = { ring: '#4b5563', width: 1, opacity: 0.55, tag: '#374151' };
    if (warn) {
      Object.assign(look, { ring: 'var(--warn)', width: 2, opacity: 1, tag: 'var(--warn)' });
    }
    if (sel) Object.assign(look, { ring: 'var(--select)', width: 2.5, opacity: 1 });
    if (sel && !warn) look.tag = 'var(--select)';
    return look;
  }
  // Ruler ticks: a labelled one runs to near the edge of the ruler, then major and minor ones.
  function tickLength(isLab, isMaj, rulerSize) {
    if (isLab) return rulerSize - 4;
    return isMaj ? 8 : 4;
  }
  function attr(el, o) {
    for (const [k, v] of Object.entries(o)) el.setAttribute(k, v);
  }
  function esc(s) {
    return String(s).replace(
      /[&<>"]/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c],
    );
  }

  function render() {
    measure();
    computeGrid();
    const S = state.settings;
    const dec = Math.min(8, Math.max(1, Math.ceil(Math.log10(Math.max(view.z, 1e-12))) + 2));
    const f = (v) => Number(v.toFixed(dec)).toString();
    placeWorkArea();
    const { dMinor, dMajor } = gridPaths();
    $('grid-minor').setAttribute('d', dMinor);
    $('grid-major').setAttribute('d', dMajor);
    const ghost = isGhost(res);
    const L = res.nodes && res.nodes.length >= 2 ? fullLine(res, S.overhang) : [];
    $('strip-layer').innerHTML = stripMarkup(L, ghost, f);
    const byId = new Map(res.pins.map((p) => [p.id, p]));
    $('pin-layer').innerHTML = pinMarkup(byId, f);
    $('overlay').innerHTML = overlayMarkup(byId, L, ghost);
    $('rulers').innerHTML = rulers();
    readouts();
  }

  function placeWorkArea() {
    const { z, tx, ty } = view;
    const { W, H } = state.settings;
    const T = `matrix(${z} 0 0 ${z} ${tx} ${ty})`;
    $('world').setAttribute('transform', T);
    $('world2').setAttribute('transform', T);
    attr($('wa-fill'), { x: 0, y: 0, width: W, height: H });
    attr($('bgimg'), { x: 0, y: 0, width: W, height: H }); // fitted inside, proportions kept
    attr($('wa-outline'), { x: 0, y: 0, width: W, height: H });
  }

  // The grid, clipped to the visible part of the work area, pixel-snapped.
  function gridPaths() {
    const z = view.z;
    const { W, H } = state.settings;
    const [vx0, vy0] = s2w(0, 0);
    const [vx1, vy1] = s2w(view.w, view.h);
    const gx0 = Math.max(0, vx0);
    const gx1 = Math.min(W, vx1);
    const gy0 = Math.max(0, vy0);
    const gy1 = Math.min(H, vy1);
    const out = { dMinor: '', dMajor: '' };
    if (!(gx1 > gx0 && gy1 > gy0)) return out;
    const sy0 = Math.round(gy0 * z + view.ty) + 0.5;
    const sy1 = Math.round(gy1 * z + view.ty) + 0.5;
    const sx0 = Math.round(gx0 * z + view.tx) + 0.5;
    const sx1 = Math.round(gx1 * z + view.tx) + 0.5;
    const step = grid.minor;
    const ratio = Math.round(grid.major / grid.minor);
    const add = (i, seg) => {
      if (i % ratio === 0) out.dMajor += seg;
      else out.dMinor += seg;
    };
    for (let i = Math.ceil(gx0 / step); i * step <= gx1; i++) {
      add(i, `M${Math.round(i * step * z + view.tx) + 0.5} ${sy0}V${sy1}`);
    }
    for (let i = Math.ceil(gy0 / step); i * step <= gy1; i++) {
      add(i, `M${sx0} ${Math.round(i * step * z + view.ty) + 0.5}H${sx1}`);
    }
    return out;
  }

  // The strip; one that is no solution for these pins is a dashed outline only.
  function stripMarkup(L, ghost, f) {
    if (!L.length) return '';
    const S = state.settings;
    if (ghost) {
      return (
        `<path d="${bandPath(L, S.t / 2, f)}" fill="var(--free)" fill-opacity="0.12" stroke="none"/>` +
        `<path d="${bezierPath(L, 0, f, false, true)}" fill="none" stroke="var(--free)" stroke-width="1.5" stroke-dasharray="6 4" vector-effect="non-scaling-stroke"/>`
      );
    }
    let out = `<path d="${bandPath(L, S.t / 2, f)}" fill="var(--strip)" fill-opacity="0.85" stroke="var(--strip-edge)" stroke-width="1" stroke-opacity="0.6" vector-effect="non-scaling-stroke"/>`;
    for (const run of tightRuns(L, S.minR)) {
      out += `<path d="${bezierPath(run, 0, f, false, true)}" fill="none" stroke="var(--tight)" stroke-width="${f(Math.max(S.t, 4 / view.z))}" stroke-opacity="0.8"/>`;
    }
    out += `<path d="${bezierPath(L, 0, f, false, true)}" fill="none" stroke="var(--centre)" stroke-width="1" vector-effect="non-scaling-stroke"/>`;
    return out;
  }

  // The pins at true size: a Through pin as a ring (the strip shows running
  // through it), an engaged one filled in its label's colour, a released one dashed.
  function pinMarkup(byId, f) {
    const r0 = f(state.settings.d / 2);
    let out = '';
    for (const p of state.pins) {
      const r = byId.get(p.id) || {};
      const col = r.engaged ? LABEL_COLOUR[r.label] || 'var(--straight)' : 'var(--free)';
      const at = `cx="${f(p.x)}" cy="${f(p.y)}" r="${r0}"`;
      if (p.mode === 'through') {
        out += `<circle ${at} fill="var(--through)" fill-opacity="0.15" stroke="var(--through)" stroke-width="2" vector-effect="non-scaling-stroke"/>`;
      } else if (r.engaged) {
        out += `<circle ${at} fill="${col}" fill-opacity="0.85" stroke="${col}" stroke-width="1" vector-effect="non-scaling-stroke"/>`;
      } else {
        out += `<circle ${at} fill="none" stroke="${col}" stroke-width="1.5" stroke-dasharray="4 3" vector-effect="non-scaling-stroke"/>`;
      }
    }
    return out;
  }

  // Everything drawn in screen pixels over the drawing.
  function overlayMarkup(byId, L, ghost) {
    let o = ghost ? '' : contactDots();
    state.pins.forEach((p, i) => {
      o += pinHandle(p, i, byId.get(p.id) || { warnings: [] }, ghost);
    });
    if (hover && !drag && !inRulers(hover.sx, hover.sy) && !pinAt(hover.sx, hover.sy)) {
      o += hoverPreview();
    }
    // where the strip bends tightest
    if (res.minRadiusAt && Number.isFinite(res.minRadius) && L.length && !ghost) {
      const q = w2s(res.minRadiusAt[0], res.minRadiusAt[1]);
      o += `<path d="M${q[0] - 5} ${q[1]}h10M${q[0]} ${q[1] - 5}v10" stroke="var(--tight)" stroke-width="1.5"/>`;
    }
    o += dimensions();
    o += scaleBar();
    if (state.pins.length < 2) {
      const msg = state.pins.length
        ? 'Click to place the second pin — the strip runs between them'
        : 'Click anywhere on the work area to place the first pin';
      o += `<text x="${(RULER_L + (view.w - RULER_L) / 2).toFixed(0)}" y="${(view.h - 40).toFixed(0)}" text-anchor="middle" fill="var(--muted)" style="font-size:13px">${esc(msg)}</text>`;
    }
    return o;
  }

  // where the strip touches each pin
  function contactDots() {
    let o = '';
    for (const r of res.pins) {
      if (r.contact) {
        const q = w2s(r.contact[0], r.contact[1]);
        o += `<circle cx="${q[0].toFixed(1)}" cy="${q[1].toFixed(1)}" r="2.6" fill="#fff" stroke="var(--centre)" stroke-width="1.2"/>`;
      }
    }
    return o;
  }

  const MODE_LETTER = { auto: 'A', left: 'L', right: 'R', through: 'T' };
  // A pin's handle ring, a dot when the pin is too small to see, and its number tag.
  function pinHandle(p, i, r, ghost) {
    const S = state.settings;
    const z = view.z;
    const q = w2s(p.x, p.y);
    const rad = Math.max(HANDLE_PX, (S.d / 2) * z + 3);
    const look = pinLook(
      p.id === state.selected,
      (r.warnings && r.warnings.length) || (!ghost && isReleased(r)),
    );
    let o = `<circle cx="${q[0].toFixed(1)}" cy="${q[1].toFixed(1)}" r="${rad.toFixed(1)}" fill="none" stroke="${look.ring}" stroke-width="${look.width}" stroke-opacity="${look.opacity}"/>`;
    if ((S.d / 2) * z < 2.5) {
      o += `<circle cx="${q[0].toFixed(1)}" cy="${q[1].toFixed(1)}" r="2.5" fill="${r.engaged ? '#374151' : '#fff'}" stroke="#374151"/>`;
    }
    const label = `${i + 1} ${MODE_LETTER[p.mode] || '?'}`;
    const bx = q[0] + rad * 0.72 + 2;
    const by = q[1] - rad * 0.72 - 2;
    const bw = 7 + label.length * 6.2;
    o += `<rect x="${bx.toFixed(1)}" y="${(by - 13).toFixed(1)}" width="${bw.toFixed(1)}" height="15" rx="3" fill="${look.tag}" fill-opacity="0.9"/>`;
    o += `<text x="${(bx + 3.5).toFixed(1)}" y="${(by - 2).toFixed(1)}" fill="#fff">${label}</text>`;
    return o;
  }

  // Where a click would put a new pin, and what it would join.
  function hoverPreview() {
    const ins = insertionFor(hover.wx, hover.wy);
    const gx = hover.alt ? hover.wx : snap(hover.wx);
    const gy = hover.alt ? hover.wy : snap(hover.wy);
    const g = w2s(gx, gy);
    let o = '';
    if (ins.kind === 'strip') {
      const q = w2s(ins.point[0], ins.point[1]);
      o += `<line x1="${q[0]}" y1="${q[1]}" x2="${g[0]}" y2="${g[1]}" stroke="var(--select)" stroke-width="1.5"/><circle cx="${q[0]}" cy="${q[1]}" r="4" fill="var(--select)"/>`;
    } else if (ins.kind === 'end') {
      const q = w2s(ins.from.x, ins.from.y);
      o += `<line x1="${q[0]}" y1="${q[1]}" x2="${g[0]}" y2="${g[1]}" stroke="var(--select)" stroke-width="1.2" stroke-dasharray="5 4"/>`;
    }
    o += `<circle cx="${g[0]}" cy="${g[1]}" r="${Math.max(HANDLE_PX - 3, (state.settings.d / 2) * view.z)}" fill="var(--select)" fill-opacity="0.15" stroke="var(--select)" stroke-dasharray="3 3"/>`;
    return o;
  }

  function arrowHead(x, y, ux, uy) {
    const a = 7;
    const b = 3;
    return `M${x} ${y}L${x - ux * a - uy * b} ${y - uy * a + ux * b}L${x - ux * a + uy * b} ${y - uy * a - ux * b}Z`;
  }
  function dimLabel(x, y, text, vertical) {
    const w = 8 + text.length * 6.3;
    const tr = vertical ? ` transform="rotate(-90 ${x} ${y})"` : '';
    return `<g${tr}><rect x="${x - w / 2}" y="${y - 8}" width="${w}" height="16" rx="3" fill="#fff" stroke="#5b6773" stroke-width="0.8"/><text x="${x}" y="${y + 4}" text-anchor="middle" fill="#1f2933" style="font-weight:600">${esc(text)}</text></g>`;
  }
  // Dimension lines for the work area; kept on screen when the edge scrolls away.
  function dimensions() {
    const S = state.settings;
    const [x0, y0] = w2s(0, 0);
    const [x1, y1] = w2s(S.W, S.H);
    let o = '';
    const yd = Math.max(RULER_T + 14, y0 - 20);
    const xd = Math.max(RULER_L + 14, x0 - 20);
    // horizontal (width)
    if (x1 > RULER_L && x0 < view.w && yd < view.h) {
      o += `<path d="M${x0} ${y0 - 4}V${yd - 5}M${x1} ${y0 - 4}V${yd - 5}" stroke="#5b6773" stroke-width="0.8" fill="none"/>`;
      o += `<path d="M${x0} ${yd}H${x1}" stroke="#1f2933" stroke-width="1" fill="none"/>`;
      o += `<path d="${arrowHead(x0, yd, -1, 0)}${arrowHead(x1, yd, 1, 0)}" fill="#1f2933"/>`;
      const lx = Math.min(
        Math.max((Math.max(x0, RULER_L) + Math.min(x1, view.w)) / 2, RULER_L + 50),
        view.w - 50,
      );
      o += dimLabel(Math.min(Math.max(lx, x0 + 40), x1 - 40) || lx, yd, fmtLen(S.W), false);
    }
    // vertical (height)
    if (y1 > RULER_T && y0 < view.h && xd < view.w) {
      o += `<path d="M${x0 - 4} ${y0}H${xd - 5}M${x0 - 4} ${y1}H${xd - 5}" stroke="#5b6773" stroke-width="0.8" fill="none"/>`;
      o += `<path d="M${xd} ${y0}V${y1}" stroke="#1f2933" stroke-width="1" fill="none"/>`;
      o += `<path d="${arrowHead(xd, y0, 0, -1)}${arrowHead(xd, y1, 0, 1)}" fill="#1f2933"/>`;
      const ly = Math.min(
        Math.max((Math.max(y0, RULER_T) + Math.min(y1, view.h)) / 2, RULER_T + 50),
        view.h - 50,
      );
      o += dimLabel(xd, Math.min(Math.max(ly, y0 + 40), y1 - 40) || ly, fmtLen(S.H), true);
    }
    return o;
  }
  function scaleBar() {
    const len = niceAtLeast(90 / view.z);
    const px = len * view.z;
    const x = RULER_L + 12;
    const y = view.h - 14;
    return (
      `<g><rect x="${x - 4}" y="${y - 18}" width="${px + 8}" height="24" rx="3" fill="#fff" fill-opacity="0.85"/>` +
      `<path d="M${x} ${y - 4}V${y}H${x + px}V${y - 4}" fill="none" stroke="#1f2933" stroke-width="1.5"/>` +
      `<text x="${x + px / 2}" y="${y - 6}" text-anchor="middle" fill="#1f2933">${esc(fmtLen(len))}</text></g>`
    );
  }
  function rulers() {
    const z = view.z;
    const w = view.w;
    const h = view.h;
    let o = `<rect x="0" y="0" width="${w}" height="${RULER_T}" fill="var(--ruler)"/><rect x="0" y="0" width="${RULER_L}" height="${h}" fill="var(--ruler)"/>`;
    o += `<path d="M0 ${RULER_T - 0.5}H${w}M${RULER_L - 0.5} 0V${h}" stroke="#b8c1ca" stroke-width="1"/>`;
    const minor = grid.minor;
    const major = grid.major;
    // label step: a multiple of the major step at least 60 px apart
    let lab = major;
    for (const m of [1, 2, 5, 10, 20, 50]) {
      lab = major * m;
      if (lab * z >= 60) break;
    }
    let ticks = '';
    let text = '';
    const [wx0, wy0] = s2w(RULER_L, RULER_T);
    const [wx1, wy1] = s2w(w, h);
    const fmtTick = (v) => fmtNum(clean(v), Math.max(0, -Math.floor(Math.log10(lab) + 1e-9)));
    for (let i = Math.ceil(wx0 / minor); i * minor <= wx1; i++) {
      const v = i * minor;
      const x = Math.round(v * z + view.tx) + 0.5;
      const isMaj = Math.abs(v / major - Math.round(v / major)) < 1e-6;
      const isLab = Math.abs(v / lab - Math.round(v / lab)) < 1e-6;
      ticks += `M${x} ${RULER_T}v${-tickLength(isLab, isMaj, RULER_T)}`;
      if (isLab) {
        text += `<text x="${x + 3}" y="11" fill="#4b5563" style="font-size:10px">${fmtTick(v)}</text>`;
      }
    }
    for (let i = Math.ceil(wy0 / minor); i * minor <= wy1; i++) {
      const v = i * minor;
      const y = Math.round(v * z + view.ty) + 0.5;
      const isMaj = Math.abs(v / major - Math.round(v / major)) < 1e-6;
      const isLab = Math.abs(v / lab - Math.round(v / lab)) < 1e-6;
      ticks += `M${RULER_L} ${y}h${-tickLength(isLab, isMaj, RULER_L)}`;
      if (isLab) {
        text += `<text x="11" y="${y - 3}" fill="#4b5563" style="font-size:10px" transform="rotate(-90 11 ${y - 3})">${fmtTick(v)}</text>`;
      }
    }
    o += `<path d="${ticks}" stroke="#7b8794" stroke-width="1" shape-rendering="crispEdges"/>${text}`;
    o += `<rect x="0" y="0" width="${RULER_L}" height="${RULER_T}" fill="var(--ruler)"/><text x="${RULER_L / 2}" y="15" text-anchor="middle" fill="#7b8794" style="font-size:10px">mm</text>`;
    return o;
  }

  const STATUS = {
    empty: [
      'Add two pins',
      'busy',
      'The strip needs at least two pins. Click on the work area to add pins.',
    ],
    converging: [
      'Converging…',
      'busy',
      'The solver is still working out the shape. The page background is amber while this takes a moment.',
    ],
    converged: [
      'Converged',
      'ok',
      'The strip is at rest on the pins: bending is balanced by the pin forces.',
    ],
    friction: ['Would slide out, held', 'bad', ''],
    failed: ['No solution', 'bad', ''],
    stalled: [
      'Not converging',
      'bad',
      'The solver is not settling on a shape; the current one is shown. Pins very close together or overlapping are the usual cause.',
    ],
    invalid: ['Pins on top of each other', 'bad', ''],
  };
  // A shape that is no solution for the current pins (an earlier layout's, a
  // failed attempt): drawn dashed, without readouts. Settled: fit to export.
  function isGhost(r) {
    return r.stale || r.status === 'failed' || r.status === 'invalid';
  }
  function isSettled(r) {
    return (r.status === 'converged' || r.status === 'friction') && !r.stale;
  }
  let lastReadout = '';
  function readouts() {
    const r = res;
    const has = r.nodes && r.nodes.length >= 2 && !isGhost(r);
    const num = new Map(state.pins.map((p, i) => [p.id, i + 1]));
    const [txt, cls, tip] = statusText(r, num);
    const warns = warningsOf(r, num, has);
    const minAt = has && r.minRadiusAt && Number.isFinite(r.minRadius) ? tightestPinText(r) : '';
    const { sel, info: pinInfo, tip: pinTip } = selectedPinInfo(r);
    // red page background for a settled result with a problem; while the solver
    // is still working keep the previous state, so a drag does not flicker
    if (r.status !== 'converging') {
      $('stage').classList.toggle('problem', cls === 'bad' || warns.length > 0);
    }
    const key = [
      txt,
      tip,
      state.pins.length,
      has ? r.length : 0,
      r.minRadius,
      minAt,
      JSON.stringify(warns),
      pinInfo,
      pinTip,
      sel && sel.id,
    ].join('#');
    if (key === lastReadout) return;
    lastReadout = key;
    writeReadouts({ txt, cls, tip, warns, has, minAt, pinInfo, pinTip });
  }

  function writeReadouts({ txt, cls, tip, warns, has, minAt, pinInfo, pinTip }) {
    const r = res;
    const nw = warns.length;
    $('status').textContent = nw ? `${txt} · ${nw} warning${nw > 1 ? 's' : ''}` : txt;
    $('status').className = nw ? 'bad' : cls;
    $('statusInfo').dataset.tip = [tip]
      .concat(warns.map(([t, x]) => `⚠ ${t}\n${x}`))
      .filter(Boolean)
      .join('\n\n');
    $('statusInfo').classList.toggle('warn', nw > 0);
    $('rPins').textContent = state.pins.length;
    $('rLen').textContent = has ? fmtLen(r.length) : '–';
    $('rBlank').textContent = has ? fmtLen(r.length + 2 * state.settings.overhang) : '–';
    let minText = '–';
    if (has) minText = Number.isFinite(r.minRadius) ? fmtLen(r.minRadius) + minAt : 'straight';
    $('rMinR').textContent = minText;
    $('rMinR').title = $('rMinR').textContent;
    $('pinInfo').textContent = pinInfo;
    $('pinInfoTip').dataset.tip = pinTip;
    $('pinInfoTip').classList.toggle('off', !pinTip);
    $('pinInfoTip').tabIndex = pinTip ? 0 : -1;
    syncPinInputs();
  }

  // The status line: [text, class, tooltip].
  function statusText(r, num) {
    let [txt, cls, tip] = STATUS[r.status] || ['–', 'busy', ''];
    if (r.status === 'failed') tip = failedTip(r);
    if (r.status === 'invalid') tip = invalidTip(r, num);
    if (r.status === 'empty' && state.pins.length >= 2) {
      [txt, cls, tip] = [
        'Need two separate pins',
        'bad',
        'All the pins are at the same position. The strip needs at least two pins at different positions.',
      ];
    }
    if (r.status === 'friction') tip = heldTip(r);
    return [txt, cls, tip];
  }
  function failedTip(r) {
    const shown = r.stale
      ? 'The dashed strip is the shape from before your last change.'
      : 'The dashed strip is the last shape it reached.';
    return `The solver could not find a shape for this layout. ${shown} Pins very close together or overlapping are the usual cause.`;
  }
  function invalidTip(r, num) {
    const why = (v) =>
      v.why === 'through'
        ? 'one is a Through pin and the other is not'
        : 'one is Left and the other Right';
    const pairs = r.invalid
      .map(
        (v) =>
          `Pins ${num.get(v.a)} and ${num.get(v.b)} are at the same position, but ${why(v)}, so they cannot share a contact.`,
      )
      .join(' ');
    const stale = r.stale ? ' The dashed strip is the shape from before your last change.' : '';
    return `${pairs} Move one of them, or give them the same mode.${stale}`;
  }
  function heldTip(r) {
    const mu = Number.isFinite(r.muReq) ? r.muReq.toFixed(2) : 'more than any real friction';
    const where = r.heldBelowLimit
      ? `at the longest length that keeps it on all its Left/Right pins, below the length limit of ${fmtNum(r.holdFactor, 2)} × the pin-to-pin distances (Settings)`
      : `at the length limit, ${fmtNum(r.holdFactor, 2)} × the pin-to-pin distances (Settings)`;
    return `On frictionless pins this layout has no resting shape: the strip would slide out. It is shown held ${where}. The end pins need a friction coefficient of at least ${mu} to hold it, or clamp the ends.`;
  }

  // Warnings for one pin n, as [short line, explanation].
  const PIN_WARNINGS = new Map([
    [
      'wrap',
      (n, r) => [
        `Pin ${n}: strip wraps round the pin`,
        `The strip bends tighter than the pin itself (radius under ${fmtLen(r.rEff)}), so it would wrap round the pin rather than touch it at one point. The shape near pin ${n} is approximate.`,
      ],
    ],
    [
      'liftoff',
      (n) => [
        `Pin ${n}: would lift off`,
        `End pin ${n} is set to Left or Right, but the strip pulls away from that side. A real strip would lift off it; set the pin to Auto or Through, or move it.`,
      ],
    ],
    [
      'marginal',
      (n) => [
        `Pin ${n}: contact keeps changing`,
        `Pin ${n}'s contact kept switching between touching and released (or between sides), so it was frozen. Pins very close together are the usual cause.`,
      ],
    ],
  ]);
  // A Left/Right pin the strip does not touch.
  function isReleased(p) {
    return (p.mode === 'left' || p.mode === 'right') && p.engaged === false;
  }
  // The warnings listed in the status tooltip, each as [short line, explanation].
  function warningsOf(r, num, has) {
    const S = state.settings;
    const warns = [];
    if (r.unstable && !isGhost(r)) {
      warns.push([
        'Unstable shape',
        'This shape is an equilibrium, but an unstable one: the slightest push would make the strip snap to another shape, often sliding out. Move the pins, or set Left/Right pins where the strip should stay.',
      ]);
    }
    // a warning about a pair of pins is listed once, under the lower pin number
    const pairs = (n, ids, make) => {
      for (const id of ids) {
        const m = num.get(id);
        if (m > n) warns.push(make(m));
      }
    };
    for (const p of r.pins) {
      const n = num.get(p.id);
      for (const w of p.warnings || []) {
        if (w === 'duplicate') {
          pairs(n, p.sameAs, (m) => [
            `Pins ${n} and ${m}: same position`,
            `Pins ${n} and ${m} are at exactly the same position, so they act as one pin. Move one of them if that is not what you meant.`,
          ]);
        } else if (w === 'overlap') {
          pairs(n, p.overlaps, (m) => [
            `Pins ${n} and ${m} overlap`,
            `Pins ${n} and ${m} are closer than the pin diameter (${fmtLen(S.d)}), so both could not be there. The shape near them is not meaningful; move one of them.`,
          ]);
        } else if (PIN_WARNINGS.has(w)) warns.push(PIN_WARNINGS.get(w)(n, r));
      }
      if (has && isReleased(p)) {
        warns.push([
          `Pin ${n}: released`,
          `Pin ${n} is set to ${p.mode === 'left' ? 'Left' : 'Right'}, but the strip does not touch it, so it does not shape the strip. Move it towards the strip, or set it to Auto.`,
        ]);
      }
    }
    if (has && S.minR > 0 && r.minRadius < S.minR) {
      warns.push([
        `Tighter than the minimum radius`,
        `Parts of the strip (drawn red) bend tighter than the minimum bend radius of ${fmtLen(S.minR)} set in Settings.`,
      ]);
    }
    return warns;
  }

  // " · pin N": the pin nearest the tightest bend.
  function tightestPinText(r) {
    let bi = -1;
    let bd = Infinity;
    state.pins.forEach((p, i) => {
      const d = Math.hypot(p.x - r.minRadiusAt[0], p.y - r.minRadiusAt[1]);
      if (d < bd) {
        bd = d;
        bi = i;
      }
    });
    return bi >= 0 ? ` · pin ${bi + 1}` : '';
  }

  // The selected pin's one-line description, and its tooltip.
  function selectedPinInfo(r) {
    const sel = getPin(state.selected);
    if (!sel) return { sel, info: 'Click a pin to select it', tip: '' };
    const sr = r.pins.find((p) => p.id === sel.id);
    if (!sr) return { sel, info: '–', tip: '' };
    const side = sr.side > 0 ? 'left' : 'right';
    const pct = Math.round((sr.force || 0) * 100);
    const load = `load ${pct}%`;
    const loadTip =
      `Load ${pct}%: how hard this pin pushes on the strip, compared with the pin that pushes hardest (100%). ` +
      `It is relative because the strip's stiffness is not known; the shape and these ratios do not depend on it. The pins with the highest load need to be the sturdiest.`;
    if (sel.mode === 'through') return { sel, info: `through the centre, ${load}`, tip: loadTip };
    if (sr.engaged) return { sel, info: `${sr.label}, on the ${side}, ${load}`, tip: loadTip };
    return {
      sel,
      info: `released (${side} side)`,
      tip: 'Released: this pin does not touch the strip, so it carries no load. It touches again as soon as the strip presses against it.',
    };
  }

  // One shared tooltip for every (i): positioned in the window, so it is never
  // clipped by the scrolling panel. Hover, or tap / keyboard focus on touch.
  const tooltip = $('tooltip');
  function showTip(el) {
    const text = el.dataset.tip;
    if (!text) {
      tooltip.hidden = true;
      return;
    }
    tooltip.textContent = text;
    tooltip.hidden = false;
    const r = el.getBoundingClientRect();
    const t = tooltip.getBoundingClientRect();
    const left = Math.max(8, Math.min(window.innerWidth - t.width - 8, r.right - t.width));
    const below = r.bottom + 6;
    const above = r.top - t.height - 6;
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${below + t.height < window.innerHeight - 8 || above < 8 ? below : above}px`;
  }
  const tipTarget = (e) => e.target.closest && e.target.closest('.info');
  document.addEventListener('mouseover', (e) => {
    const el = tipTarget(e);
    if (el) showTip(el);
  });
  document.addEventListener('mouseout', (e) => {
    const el = tipTarget(e);
    if (el && el !== document.activeElement) tooltip.hidden = true;
  });
  document.addEventListener('focusin', (e) => {
    const el = tipTarget(e);
    if (el) showTip(el);
  });
  document.addEventListener('focusout', (e) => {
    if (tipTarget(e)) tooltip.hidden = true;
  });
  $('panel').addEventListener('scroll', () => {
    tooltip.hidden = true;
  });

  // Foldable sections remember whether they are open.
  const SECTIONS_KEY = 'springStripJig.sections';
  try {
    const open = JSON.parse(localStorage.getItem(SECTIONS_KEY) || 'null');
    if (open) {
      for (const d of document.querySelectorAll('details.sec')) {
        d.open = Boolean(open[d.dataset.sec]);
      }
    }
  } catch {
    /* storage unavailable: keep the defaults */
  }
  for (const d of document.querySelectorAll('details.sec')) {
    d.addEventListener('toggle', () => {
      const open = {};
      for (const x of document.querySelectorAll('details.sec')) open[x.dataset.sec] = x.open;
      try {
        localStorage.setItem(SECTIONS_KEY, JSON.stringify(open));
      } catch {
        /* ignore */
      }
    });
  }

  // ---------------------------------------------------------------- SVG export / import
  function buildSVG(layers) {
    if (pinsDirty) {
      solver.setPins(state.pins);
      pinsDirty = false;
    }
    solver.solve(3000);
    res = solver.result();
    const S = state.settings;
    const W = S.W;
    const H = S.H;
    const f = (v) => {
      const s = (Math.round(v * 100) / 100).toFixed(2).replace(/\.?0+$/, '');
      return s === '-0' ? '0' : s;
    };
    const stroke = (c) => `fill="none" stroke="${c}" stroke-width="0.1"`;
    const layer = (id, body, extra) =>
      `  <g id="${id}" inkscape:groupmode="layer" inkscape:label="${id}"${extra || ''}>\n${body}  </g>\n`;
    let out = `<?xml version="1.0" encoding="UTF-8"?>\n`;
    out += `<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" width="${f(W)}mm" height="${f(H)}mm" viewBox="0 0 ${f(W)} ${f(H)}">\n`;
    out += `  <title>Spring strip jig</title>\n`;
    const note = exportNote(res);
    if (note) out += `  <desc>${esc(note)}</desc>\n`;
    out += `  <metadata id="spring-strip-project"><![CDATA[${snapshot()}]]></metadata>\n`;
    if (layers.has('grid')) {
      const step = niceAtLeast(Math.max(W, H) / 60);
      let d = '';
      for (let x = step; x < W - 1e-9; x += step) d += `M${f(x)} 0V${f(H)}`;
      for (let y = step; y < H - 1e-9; y += step) d += `M0 ${f(y)}H${f(W)}`;
      out += layer('grid', `    <path d="${d}" ${stroke('#b0b8c0')}/>\n`);
    }
    if (layers.has('work-area')) {
      out += layer(
        'work-area',
        `    <rect x="0" y="0" width="${f(W)}" height="${f(H)}" ${stroke('#000000')}/>\n`,
      );
    }
    if (layers.has('pins')) {
      out += layer(
        'pins',
        state.pins
          .map(
            (p) =>
              `    <circle cx="${f(p.x)}" cy="${f(p.y)}" r="${f(S.d / 2)}" ${stroke('#000000')}/>\n`,
          )
          .join(''),
      );
    }
    if (layers.has('pin-centres')) {
      const c = S.d / 4;
      out += layer(
        'pin-centres',
        state.pins
          .map(
            (p) =>
              `    <path d="M${f(p.x - c)} ${f(p.y)}H${f(p.x + c)}M${f(p.x)} ${f(p.y - c)}V${f(p.y + c)}" ${stroke('#0000ff')}/>\n`,
          )
          .join(''),
      );
    }
    // the strip only once it has settled for these pins: a drawing to build from
    const L = isSettled(res) && res.nodes && res.nodes.length >= 2 ? fullLine(res, S.overhang) : [];
    if (layers.has('strip-outline') && L.length) {
      out += layer(
        'strip-outline',
        `    <path d="${bandPath(L, S.t / 2, f)}" ${stroke('#ff0000')}/>\n`,
      );
    }
    if (layers.has('strip-centreline') && L.length) {
      out += layer(
        'strip-centreline',
        `    <path d="${bezierPath(L, 0, f, false, true)}" ${stroke('#00a000')}/>\n`,
      );
    }
    if (layers.has('labels')) {
      const fs = Math.max(W, H) / 120;
      let b = state.pins
        .map(
          (p, i) =>
            `    <text x="${f(p.x + S.d / 2 + fs * 0.3)}" y="${f(p.y - S.d / 2 - fs * 0.3)}" font-family="sans-serif" font-size="${f(fs)}" fill="#000000">${i + 1}</text>\n`,
        )
        .join('');
      if (L.length) {
        b += `    <text x="${f(fs)}" y="${f(H - fs)}" font-family="sans-serif" font-size="${f(fs)}" fill="#000000">${esc(`Work area ${fmtLen(W)} × ${fmtLen(H)}; pin Ø ${fmtLen(S.d)}; strip ${fmtLen(S.t)}; blank ${fmtLen(res.length + 2 * S.overhang)}`)}</text>\n`;
      }
      out += layer('labels', b);
    }
    out += `</svg>\n`;
    return out;
  }
  function download(text, name, type) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  // What the drawing's <desc> says about the strip, if anything.
  function exportNote(r) {
    if (!isSettled(r)) {
      return `The strip is not included: it has not settled for these pins (${(STATUS[r.status] || [r.status])[0]}).`;
    }
    if (r.status === 'friction') {
      return `On frictionless pins this layout would slide out; the strip is shown held. The end pins need a friction coefficient of at least ${Number.isFinite(r.muReq) ? r.muReq.toFixed(2) : 'more than any real friction'}.`;
    }
    if (r.unstable) {
      return 'The strip shape is an unstable equilibrium: a real strip would snap to another shape.';
    }
    return '';
  }
  function exportSVG() {
    const layers = new Set(
      [...document.querySelectorAll('[data-layer]')]
        .filter((c) => c.checked)
        .map((c) => c.dataset.layer),
    );
    download(buildSVG(layers), 'spring-strip.svg', 'image/svg+xml');
    if ((layers.has('strip-outline') || layers.has('strip-centreline')) && !isSettled(res)) {
      ioMessage(
        `Downloaded the pins only: the strip has not settled (${(STATUS[res.status] || [res.status])[0]})`,
        false,
      );
    } else ioMessage('Downloaded spring-strip.svg', true);
  }

  // Pin coordinates as TSV: a header row, then x, y (mm, y down) and mode.
  function buildTSV() {
    const num = (v) => String(Number(v.toFixed(6)));
    return `${['x\ty\tmode']
      .concat(state.pins.map((p) => [num(p.x), num(p.y), p.mode].join('\t')))
      .join('\n')}\n`;
  }
  const MODE_NAMES = {
    through: 'through',
    t: 'through',
    auto: 'auto',
    a: 'auto',
    left: 'left',
    l: 'left',
    right: 'right',
    r: 'right',
  };
  // Lines: x, y and an optional mode, separated by tabs (or spaces). Blank
  // lines and # comments are skipped, and so is a header as the first line.
  function parseTSV(text) {
    const pins = [];
    let first = true;
    text.split(/\r\n|\r|\n/).forEach((line, i) => {
      const t = line.trim();
      if (!t || t.startsWith('#')) return;
      const f = (t.includes('\t') ? t.split('\t') : t.split(/ +/)).map((c) => c.trim());
      const isFirst = first;
      first = false;
      const num = (c) =>
        c !== undefined && c !== '' && Number.isFinite(Number(c)) ? Number(c) : NaN;
      const x = num(f[0]);
      const y = num(f[1]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        if (isFirst && !Number.isFinite(num(f[0]))) return; // a header row
        throw new Error(`line ${i + 1}: expected numbers x and y, got "${t.slice(0, 40)}"`);
      }
      let mode = DEFAULT_MODE;
      if (f[2]) {
        mode = MODE_NAMES[f[2].toLowerCase()];
        if (!mode) {
          throw new Error(
            `line ${i + 1}: unknown mode "${f[2]}" (use through, auto, left or right)`,
          );
        }
      }
      if (f.slice(3).some((c) => c !== '')) throw new Error(`line ${i + 1}: more than 3 columns`);
      pins.push({ x, y, mode });
    });
    if (!pins.length) throw new Error('no coordinates found');
    return pins;
  }
  function parseProject(text) {
    const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
    const md = doc.getElementById('spring-strip-project');
    if (!md) throw new Error('it has no spring-strip project data');
    const o = JSON.parse(md.textContent);
    if (!o || !Array.isArray(o.pins)) throw new Error('the project data is not valid');
    return o;
  }

  // ---------------------------------------------------------------- start
  let loaded = false;
  try {
    const s = localStorage.getItem(STORE_KEY);
    if (s) {
      restore(s);
      loaded = true;
    }
  } catch {
    loaded = false;
  }
  if (!loaded) loadExample();
  syncInputs();
  requestAnimationFrame(() => {
    fitArea();
  });

  // test hooks
  window.__jig = {
    state,
    solver,
    view,
    get res() {
      return res;
    },
    get grid() {
      return grid;
    },
    buildSVG,
    buildTSV,
    parseTSV,
    openText,
    fitArea,
    undo,
    redo,
    snapshot,
    restore,
    parseProject,
    checkProject,
    // resolves with the status once a frame has run and the solver has nothing left to do
    whenIdle: () =>
      new Promise((resolve) => {
        idleWaiters.push(resolve);
        requestRender();
      }),
  };
})();
