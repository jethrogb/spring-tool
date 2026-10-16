// Headless browser check of the built spring-tool.html with Playwright.
// Run: npm test   (after `npm install`; or: npm run test:browser)
// One browser session, in named steps that run in order and share its state.
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { test } = require('node:test');
const assert = require('node:assert');

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  console.error('Playwright is not installed. Run `npm install` once, then `npm test` again.');
  process.exit(1);
}

const FILE = `file://${path.join(__dirname, '..', 'spring-tool.html')}`;
const OUT = process.argv[2] || path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });
const ALL_LAYERS = [
  'work-area',
  'pins',
  'pin-centres',
  'strip-outline',
  'strip-centreline',
  'grid',
  'labels',
];

// Soft checks, as in the solver tests: every failing check in a step is reported.
let failures = 0;
let passes = 0;
let failed = [];
function check(cond, msg) {
  if (cond) passes++;
  else {
    failures++;
    failed.push(msg);
    console.log(`  FAIL: ${msg}`);
  }
}
function step(t, name, fn) {
  return t.test(name, async () => {
    failed = [];
    await fn();
    assert.deepStrictEqual(failed, [], `${failed.length} check(s) failed`);
  });
}

// Waits are on conditions, never on the clock. Ready: the app has started
// (CSS transitions off, so styles are final at once). Idle: a frame has run
// and the solver has nothing left to do; resolves with the status.
const idle = (p) =>
  p.evaluate(() =>
    Promise.race([__jig.whenIdle(), new Promise((r) => setTimeout(() => r('timeout'), 10000))]),
  );
async function ready(p) {
  await p.waitForFunction(() => window.__jig);
  await p.addStyleTag({ content: '*, *::before, *::after { transition: none !important; }' });
  return idle(p);
}
const tooltipText = (page) =>
  page.evaluate(() => {
    const t = document.getElementById('tooltip');
    return t.hidden ? null : t.textContent;
  });

// Helpers bound to the main page.
function helpers(page) {
  const settle = () => idle(page);
  return {
    settle,
    J: () =>
      page.evaluate(() => ({
        tx: __jig.view.tx,
        ty: __jig.view.ty,
        pins: __jig.state.pins.map((p) => ({ id: p.id, x: p.x, y: p.y, mode: p.mode })),
        status: __jig.res.status,
        len: __jig.res.length,
        minor: __jig.grid.minor,
        z: __jig.view.z,
        selected: __jig.state.selected,
        res: __jig.res.pins.map((p) => ({
          id: p.id,
          engaged: p.engaged,
          label: p.label,
          side: p.side,
        })),
      })),
    // open a file with the Open button: done once the message line reports it
    openFile: async (files) => {
      await page.evaluate(() => {
        document.getElementById('ioMsg').textContent = '';
      });
      await page.setInputFiles('#fileOpen', files);
      await page.waitForFunction(() => document.getElementById('ioMsg').textContent !== '');
      return settle();
    },
    toScreen: (x, y) =>
      page.evaluate(
        ([wx, wy]) => {
          const v = __jig.view;
          const r = document.getElementById('view').getBoundingClientRect();
          return [r.left + wx * v.z + v.tx, r.top + wy * v.z + v.ty];
        },
        [x, y],
      ),
    sections: () =>
      page.evaluate(() =>
        Object.fromEntries(
          [...document.querySelectorAll('details.sec')].map((d) => [d.dataset.sec, d.open]),
        ),
      ),
    // positions of everything in Result and Selected pin, and of what follows
    // them (panel scrolling is not a jump)
    layout: () =>
      page.evaluate(() =>
        [...document.querySelectorAll('#panel .box, #panel .box *, details.sec > summary')]
          .map((e) => {
            const r = e.getBoundingClientRect();
            const top = Math.round(r.top + document.getElementById('panel').scrollTop);
            return [top, Math.round(r.height)].join(',');
          })
          .join(' '),
      ),
  };
}

async function initialExample(page, h) {
  const s = await h.J();
  check(s.pins.length === 5, `example has 5 pins, got ${s.pins.length}`);
  check((await h.settle()) === 'converged', 'example converges');
  await page.screenshot({ path: path.join(OUT, 'example-600mm.png') });
}

async function sidebar(page, h) {
  const sections = await h.sections();
  check(
    JSON.stringify(sections) === JSON.stringify({ settings: true, help: false, io: false }),
    `default sections: ${JSON.stringify(sections)}`,
  );
  const disabled =
    (await page.isDisabled('#inPX')) &&
    (await page.isDisabled('#mThrough')) &&
    (await page.isDisabled('#btnDel'));
  check(disabled, 'pin fields disabled with no pin selected');
  const layout0 = await h.layout();
  const p0 = (await h.J()).pins[1];
  const [qx, qy] = await h.toScreen(p0.x, p0.y);
  await page.mouse.click(qx, qy);
  await h.settle();
  check(!(await page.isDisabled('#inPX')), 'pin fields enabled with a pin selected');
  await page.hover('#pinInfoTip');
  const ptip = await tooltipText(page);
  check(
    ptip && /Load \d+%: how hard this pin pushes/.test(ptip),
    `pin info tooltip explains the load: ${ptip}`,
  );
  await page.mouse.move(5, 300);
  check((await h.layout()) === layout0, 'no layout jump when a pin is selected');
  await page.keyboard.press('Escape');
  await h.settle();
  await page.fill('#inR', '10000');
  await page.press('#inR', 'Enter');
  await h.settle();
  const l1 = await h.layout();
  const a = layout0.split(' ');
  const b = l1.split(' ');
  const diff = a.map((v, i) => (v !== b[i] ? `${i}:${v}->${b[i]}` : null)).filter(Boolean);
  check(
    l1 === layout0,
    `no layout jump when warnings appear ${diff.slice(0, 6).join(' ')} n=${a.length}/${b.length}`,
  );
  const st = await page.textContent('#status');
  check(/warning/.test(st), `status shows the warning count: ${st}`);
  await page.hover('#statusInfo');
  const tip = await tooltipText(page);
  check(tip && /minimum bend radius/.test(tip), `status tooltip explains the warning: ${tip}`);
  await page.mouse.move(5, 300); // move off the (i): hide the tooltip
  await page.fill('#inR', '0');
  await page.press('#inR', 'Enter');
  await h.settle();
  check((await h.layout()) === layout0, 'no layout jump when warnings go away');
}

// add + drag at the end (far from the strip), as one undo step
async function addAndDrag(page, h) {
  const [sx, sy] = await h.toScreen(580, 60);
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(sx - i * 3, sy + i * 4);
  await page.mouse.up();
  await h.settle();
  const s = await h.J();
  check(s.pins.length === 6, 'add+drag adds a pin');
  check(Math.abs(s.pins[5].y - 60) > 20, `new pin followed the drag (y=${s.pins[5].y})`);
  check(s.status === 'converged' || s.status === 'friction', `status after add ${s.status}`);
  await page.keyboard.press('Control+z');
  await h.settle();
  check((await h.J()).pins.length === 5, 'undo removes the add+drag in one step');
  await page.keyboard.press('Control+Shift+z');
  await h.settle();
  check((await h.J()).pins.length === 6, 'redo restores it');
}

// press on the strip between pins 2 and 3; then move pin 1
async function insertAndMove(page, h) {
  const mid = await page.evaluate(() => {
    const r = __jig.res;
    const p2 = r.pins[1].contact;
    const p3 = r.pins[2].contact;
    let best = null;
    let bd = Infinity;
    for (const q of r.nodes) {
      const d = Math.abs(
        Math.hypot(q[0] - p2[0], q[1] - p2[1]) - Math.hypot(q[0] - p3[0], q[1] - p3[1]),
      );
      if (d < bd) {
        bd = d;
        best = q;
      }
    }
    return best;
  });
  let [sx, sy] = await h.toScreen(mid[0], mid[1]);
  await page.mouse.click(sx, sy + 2);
  await h.settle();
  let s = await h.J();
  check(s.pins.length === 7, 'click near strip adds a pin');
  const insertedIdx = s.pins.findIndex((p) => p.id === s.selected);
  check(insertedIdx === 2, `pin inserted into stretch 2–3 (index ${insertedIdx})`);
  const p0 = s.pins[0];
  [sx, sy] = await h.toScreen(p0.x, p0.y);
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  await page.mouse.move(sx + 20, sy - 30, { steps: 6 });
  await page.mouse.up();
  await h.settle();
  s = await h.J();
  check(s.pins.length === 7 && (s.pins[0].x !== p0.x || s.pins[0].y !== p0.y), 'drag moved pin 1');
}

// new pins and the example are Through; double-click, keys and buttons
async function modes(page, h) {
  let s = await h.J();
  check(
    s.pins.every((p) => p.mode === 'through'),
    'new pins and the example are Through pins',
  );
  const [sx, sy] = await h.toScreen(s.pins[3].x, s.pins[3].y);
  await page.mouse.dblclick(sx, sy);
  await h.settle();
  s = await h.J();
  check(s.pins[3].mode === 'auto', `double-click cycles Through → Auto, got ${s.pins[3].mode}`);
  const steps = [
    [() => page.keyboard.press('x'), 'left', 'X cycles Auto → Left'],
    [() => page.keyboard.press('x'), 'right', 'X cycles Left → Right'],
    [() => page.keyboard.press('x'), 'through', 'X cycles Right → Through'],
    [() => page.keyboard.press('a'), 'auto', 'A sets Auto'],
    [() => page.click('#mLeft'), 'left', 'panel Left button'],
    [() => page.keyboard.press('t'), 'through', 'T sets Through'],
    [() => page.click('#mAuto'), 'auto', 'panel Auto button'],
  ];
  for (const [act, want, msg] of steps) {
    await act();
    await h.settle();
    check((await h.J()).pins[3].mode === want, msg);
  }
  await page.click('#mThrough');
  await h.settle();
  s = await h.J();
  const rp = s.res.find((q) => q.id === s.pins[3].id);
  check(
    s.pins[3].mode === 'through' && rp && rp.engaged && rp.label === 'through',
    `Through button, pin stays engaged: ${JSON.stringify(rp)}`,
  );
}

// a settled result with a problem shows a red page background
async function problemBackground(page, h) {
  const problemBg = () =>
    page.evaluate(() => document.getElementById('stage').classList.contains('problem'));
  check(!(await problemBg()), 'no problem background for a clean result');
  await page.fill('#inR', '10000'); // every bend is tighter than 10 m
  await page.press('#inR', 'Enter');
  await h.settle();
  check(await problemBg(), 'problem background when the result has a warning');
  // zoomed in, the work area hides the background: the rulers and the frame show it too
  const st = await page.evaluate(() => {
    const r = document.querySelector('#rulers rect');
    const f = getComputedStyle(document.getElementById('stage'), '::after').boxShadow;
    return { ruler: getComputedStyle(r).fill, frame: f };
  });
  check(
    st.ruler === 'rgb(243, 201, 196)' && /217, 83, 79/.test(st.frame),
    `rulers and frame show the problem state: ${JSON.stringify(st)}`,
  );
  await page.fill('#inR', '0');
  await page.press('#inR', 'Enter');
  await h.settle();
  check(!(await problemBg()), 'problem background cleared again');
  const off =
    (await page.inputValue('#inR')) === '' &&
    (await page.getAttribute('#inR', 'placeholder')) === 'off';
  check(off, 'minimum radius 0 shows as "off"');
  await page.fill('#inR', '50');
  await page.press('#inR', 'Enter');
  await h.settle();
  await page.fill('#inR', '');
  await page.press('#inR', 'Enter');
  await h.settle();
  const cleared =
    (await page.evaluate(() => __jig.state.settings.minR)) === 0 &&
    (await page.inputValue('#inR')) === '';
  check(cleared, 'clearing the minimum radius turns the check off');
}

// numeric edit, then delete by right-click and by the Delete key
async function editAndDelete(page, h) {
  await page.fill('#inPX', '333');
  await page.press('#inPX', 'Enter');
  await h.settle();
  check((await h.J()).pins[3].x === 333, 'numeric X edit');
  let s = await h.J();
  let [sx, sy] = await h.toScreen(s.pins[2].x, s.pins[2].y);
  await page.mouse.click(sx, sy, { button: 'right' });
  await h.settle();
  check((await h.J()).pins.length === 6, 'right-click deletes a pin');
  s = await h.J();
  [sx, sy] = await h.toScreen(s.pins[1].x, s.pins[1].y);
  await page.mouse.click(sx, sy);
  await page.keyboard.press('Delete');
  await h.settle();
  check((await h.J()).pins.length === 5, 'Delete key removes the selected pin');
  await page.keyboard.press('Escape');
}

// zoom changes the grid step; drag on a ruler, middle and right drag pan
async function zoomAndPan(page, h, shared) {
  const before = await h.J();
  const box = await page.locator('#view').boundingBox();
  shared.box = box;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 8; i++) await page.mouse.wheel(0, -300);
  await h.settle();
  const after = await h.J();
  check(after.z > before.z * 4, 'wheel zoomed in');
  check(
    after.minor < before.minor,
    `grid step shrinks on zoom-in (${before.minor} → ${after.minor})`,
  );
  const pxStep = after.minor * after.z;
  check(
    pxStep >= 8 - 1e-9 && pxStep < 8 * 2.5 + 1e-9,
    `minor grid step on screen ${pxStep.toFixed(1)} px`,
  );
  const panBy = async (fn) => {
    const a = await h.J();
    await fn();
    await h.settle();
    const b = await h.J();
    return {
      dx: Math.round(b.tx - a.tx),
      dy: Math.round(b.ty - a.ty),
      added: b.pins.length - a.pins.length,
    };
  };
  await page.evaluate(() => {
    __jig.view.tx = Math.round(__jig.view.tx);
    __jig.view.ty = Math.round(__jig.view.ty);
  });
  const px = box.x + box.width * 0.6;
  const py = box.y + box.height * 0.85;
  const drag = (x0, y0, x1, y1, button) => async () => {
    await page.mouse.move(x0, y0);
    await page.mouse.down({ button });
    await page.mouse.move(x1, y1, { steps: 4 });
    await page.mouse.up({ button });
  };
  let d = await panBy(drag(px, box.y + 10, px + 60, box.y + 40, 'left'));
  check(
    d.dx === 60 && d.dy === 30 && d.added === 0,
    `drag on the top ruler pans: ${JSON.stringify(d)}`,
  );
  d = await panBy(drag(px, py, px - 40, py - 20, 'middle'));
  check(d.dx === -40 && d.dy === -20 && d.added === 0, `middle-drag pans: ${JSON.stringify(d)}`);
  d = await panBy(drag(px, py, px + 30, py + 10, 'right'));
  check(
    d.dx === 30 && d.dy === 10 && d.added === 0,
    `right-drag on empty space pans: ${JSON.stringify(d)}`,
  );
  await page.click('#btnFit');
}

// export SVG (Import/export is closed by default), then open it again
async function svgExportAndOpen(page, h) {
  await page.click('details[data-sec="io"] > summary');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btnExport')]);
  check(dl.suggestedFilename() === 'spring-strip.svg', `download name ${dl.suggestedFilename()}`);
  const svgPath = path.join(OUT, 'spring-strip-600.svg');
  await dl.saveAs(svgPath);
  const svgText = fs.readFileSync(svgPath, 'utf8');
  check(
    /width="600mm" height="400mm" viewBox="0 0 600 400"/.test(svgText),
    'mm width/height and viewBox',
  );
  for (const id of ['work-area', 'pins', 'pin-centres', 'strip-outline', 'strip-centreline']) {
    check(
      svgText.includes(`id="${id}" inkscape:groupmode="layer" inkscape:label="${id}"`),
      `layer ${id}`,
    );
  }
  check(
    !svgText.includes('id="grid"') && !svgText.includes('id="labels"'),
    'grid and labels off by default',
  );
  check(!/NaN|Infinity/.test(svgText), 'no NaN in export');
  const pinsBefore = (await h.J()).pins;
  await page.click('#btnClear');
  check((await h.J()).pins.length === 0, 'clear all');
  await h.openFile(svgPath);
  const reopened = await h.J();
  check(JSON.stringify(reopened.pins) === JSON.stringify(pinsBefore), 'Open SVG restores the pins');
}

// pin coordinates as TSV: download, open, errors
async function tsvExportAndOpen(page, h) {
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btnExportTsv')]);
  check(
    dl.suggestedFilename() === 'spring-strip-pins.tsv',
    `TSV download name ${dl.suggestedFilename()}`,
  );
  const tsvPath = path.join(OUT, 'spring-strip-pins.tsv');
  await dl.saveAs(tsvPath);
  const tsv = fs.readFileSync(tsvPath, 'utf8').trim().split('\n');
  const pinsNow = (await h.J()).pins;
  check(
    tsv[0] === 'x\ty\tmode' && tsv.length === pinsNow.length + 1,
    'TSV header and one row per pin',
  );
  const rowsMatch = tsv.slice(1).every((l, i) => {
    const [x, y, m] = l.split('\t');
    return Number(x) === pinsNow[i].x && Number(y) === pinsNow[i].y && m === pinsNow[i].mode;
  });
  check(rowsMatch, 'TSV rows match the pins');
  const openTsv = async (name, text) => {
    await h.openFile({ name, mimeType: 'text/tab-separated-values', buffer: Buffer.from(text) });
    return { pins: (await h.J()).pins, msg: await page.textContent('#ioMsg') };
  };
  let o = await openTsv(
    'in.tsv',
    '# made by hand\nx\ty\tmode\n10\t20\n110\t60\tauto\n\n210 20 L\n310\t70\tright\n',
  );
  check(
    o.pins.length === 4 &&
      o.pins.map((p) => p.mode).join() === 'through,auto,left,right' &&
      o.pins[2].x === 210 &&
      o.pins[2].y === 20,
    `TSV opened (header, comment, blank line, spaces, short mode names): ${JSON.stringify(o.pins.map((p) => [p.x, p.y, p.mode]))}`,
  );
  check(/Opened in\.tsv: 4 pins/.test(o.msg), `open message: ${o.msg}`);
  o = await openTsv('bad.tsv', '10\t20\n30\tabc\n');
  check(
    o.pins.length === 4 && /line 2/.test(o.msg),
    `bad TSV is refused with the line number, pins unchanged: ${o.msg}`,
  );
  o = await openTsv('bad2.tsv', '10\t20\tsideways\n');
  check(/unknown mode/.test(o.msg), `unknown mode is reported: ${o.msg}`);
  await page.keyboard.press('Control+z');
  await h.settle();
  check(
    (await h.J()).pins.length === pinsNow.length,
    'undo after opening a TSV restores the previous pins',
  );
  o = await openTsv('spring-strip-pins.tsv', fs.readFileSync(tsvPath, 'utf8'));
  const same =
    JSON.stringify(o.pins.map((p) => [p.x, p.y, p.mode])) ===
    JSON.stringify(pinsNow.map((p) => [p.x, p.y, p.mode]));
  check(same, 'downloaded TSV opens to the same pins');
}

// F fits the work area; pressed again it fits the pins
async function fitKeys(page, h, shared) {
  const { box } = shared;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -300);
  await h.settle();
  const vw = () =>
    page.evaluate(() =>
      [__jig.view.z, __jig.view.tx, __jig.view.ty].map((v) => Number(v.toFixed(3))).join(),
    );
  await page.keyboard.press('f');
  await h.settle();
  const vArea = await vw();
  const fitted = await page.evaluate(() => {
    const v = __jig.fitArea(false);
    return [v.z, v.tx, v.ty].map((x) => Number(x.toFixed(3))).join();
  });
  check(vArea === fitted, 'F fits the work area');
  await page.keyboard.press('f');
  await h.settle();
  check((await vw()) !== vArea, 'F again fits the pins');
  await page.keyboard.press('f');
  await h.settle();
  check((await vw()) === vArea, 'and F once more fits the work area again');
}

// A 4×1 PNG, made here so the test needs no image file.
function tinyPng() {
  const table = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const x of buf) c = table[(c ^ x) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(4, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const pixels = zlib.deflateSync(Buffer.from([0, 255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0]));
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', pixels),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// background image: fitted to the work area, not exported, remembered
async function backgroundImage(page) {
  await page.setInputFiles('#fileBg', {
    name: 'plan.png',
    mimeType: 'image/png',
    buffer: tinyPng(),
  });
  await page.waitForFunction(() => Boolean(document.getElementById('bgimg').getAttribute('href')));
  const im = await page.evaluate(() => {
    const e = document.getElementById('bgimg');
    return {
      href: e.getAttribute('href') || '',
      shown: e.style.display !== 'none',
      par: e.getAttribute('preserveAspectRatio'),
      w: Number(e.getAttribute('width')),
      h: Number(e.getAttribute('height')),
      op: e.getAttribute('opacity'),
    };
  });
  const W0 = await page.evaluate(() => [__jig.state.settings.W, __jig.state.settings.H]);
  check(
    im.shown &&
      im.href.startsWith('data:image/png') &&
      im.par === 'xMidYMid meet' &&
      im.w === W0[0] &&
      im.h === W0[1],
    `background image fitted to the work area: ${JSON.stringify({ ...im, href: im.href.slice(0, 20) })}`,
  );
  const svg = await page.evaluate((layers) => __jig.buildSVG(new Set(layers)), ALL_LAYERS);
  check(!/<image|data:image/.test(svg), 'background image not in the exported SVG');
  await page.fill('#inBgOpacity', '0.8');
  await page.dispatchEvent('#inBgOpacity', 'change');
  check(
    (await page.evaluate(() => document.getElementById('bgimg').getAttribute('opacity'))) === '0.8',
    'image opacity',
  );
  await page.reload();
  await ready(page);
  const kept = await page.evaluate(() => {
    const e = document.getElementById('bgimg');
    return (
      (e.getAttribute('href') || '').startsWith('data:image/png') &&
      e.getAttribute('opacity') === '0.8'
    );
  });
  check(kept, 'background image remembered after a reload');
  await page.click('#btnBgRemove');
  const gone = await page.evaluate(() => {
    const e = document.getElementById('bgimg');
    return e.style.display === 'none' && !e.getAttribute('href');
  });
  check(gone, 'Remove takes the image away');
}

// room scale: 6 m × 6 m with 30 mm pins
async function roomScale(page, h) {
  await page.evaluate(() => {
    const pts = [
      [400, 3200],
      [1300, 2300],
      [2500, 1900],
      [3600, 2700],
      [4400, 4100],
      [5300, 4600],
      [5700, 3600],
    ];
    __jig.restore({
      settings: { W: 6000, H: 6000, d: 30, t: 12, overhang: 150, minR: 1500, tauHat: 0.01 },
      pins: pts.map(([x, y], i) => ({ id: i + 1, x, y, mode: 'auto' })),
    });
    __jig.fitArea();
  });
  check((await h.settle()) === 'converged', 'room-scale layout converges');
  await page.screenshot({ path: path.join(OUT, 'room-6m.png') });
  const room = await h.J();
  check(room.minor >= 10, `room-scale grid step ${room.minor} mm`);
  // a 30 mm pin must still be selectable at this zoom
  const [sx, sy] = await h.toScreen(room.pins[2].x + 0.5, room.pins[2].y);
  await page.mouse.click(sx + 4, sy);
  check(
    (await h.J()).selected === room.pins[2].id,
    'small pin selectable at room scale via its handle',
  );
  await page.keyboard.press('Escape');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btnExport')]);
  const svgPath = path.join(OUT, 'spring-strip-6m.svg');
  await dl.saveAs(svgPath);
  check(
    /width="6000mm" height="6000mm" viewBox="0 0 6000 6000"/.test(fs.readFileSync(svgPath, 'utf8')),
    'room-scale export dimensions',
  );
}

// touch: one finger adds a pin, a second finger turns it into a pinch and drops that pin
async function touch(browser, errors) {
  const tctx = await browser.newContext({ viewport: { width: 1000, height: 700 }, hasTouch: true });
  const tp = await tctx.newPage();
  tp.on('pageerror', (e) => errors.push(e.message));
  await tp.goto(FILE);
  await ready(tp);
  const cdp = await tctx.newCDPSession(tp);
  const before = await tp.evaluate(() => ({ n: __jig.state.pins.length, z: __jig.view.z }));
  const b = await tp.locator('#view').boundingBox();
  const cx = b.x + b.width * 0.5;
  const cy = b.y + b.height * 0.2;
  const send = (type, pts) =>
    cdp.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: pts.map((p, i) => ({ x: p[0], y: p[1], id: i })),
    });
  await send('touchStart', [[cx, cy]]);
  await tp
    .waitForFunction((n) => __jig.state.pins.length === n, before.n + 1, { timeout: 5000 })
    .catch(() => {});
  const mid = await tp.evaluate(() => __jig.state.pins.length);
  await send('touchStart', [
    [cx, cy],
    [cx + 40, cy + 40],
  ]);
  for (let i = 1; i <= 8; i++) {
    await send('touchMove', [
      [cx - i * 10, cy - i * 10],
      [cx + 40 + i * 10, cy + 40 + i * 10],
    ]);
  }
  await send('touchEnd', []);
  await idle(tp);
  const after = await tp.evaluate(() => ({ n: __jig.state.pins.length, z: __jig.view.z }));
  check(mid === before.n + 1, 'one-finger touch adds a pin');
  check(
    after.n === before.n,
    `pinch removes the pin the first finger added (${before.n} → ${after.n})`,
  );
  check(after.z > before.z * 1.5, 'pinch zooms in');
  await tctx.close();
}

// a slow solve shows on the page background after a moment: on Playwright's
// clock, so the 200 ms delay is exact (the solver is stubbed to never finish).
// Its own page: there the whole solve runs in one frame.
async function busyBackground(browser, errors) {
  const bctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const bp = await bctx.newPage();
  bp.on('pageerror', (e) => errors.push(e.message));
  await bp.clock.install();
  await bp.goto(FILE);
  await bp.clock.runFor(1000);
  const busy = () =>
    bp.evaluate(() => document.getElementById('stage').classList.contains('converging'));
  await bp.evaluate(() => {
    __jig.state.selected = __jig.state.pins[1].id;
    const sv = __jig.solver;
    sv.__run = sv.run;
    sv.run = () => {
      sv.status = 'converging';
      return true;
    };
  });
  await bp.keyboard.press('ArrowUp'); // any edit starts a solve
  await bp.clock.runFor(100);
  check(!(await busy()), 'no busy background for a quick solve');
  await bp.clock.runFor(300);
  check(await busy(), 'busy background while still converging after a moment');
  await bp.evaluate(() => {
    const sv = __jig.solver;
    sv.run = sv.__run;
    delete sv.__run;
    sv.status = 'converging';
  });
  await bp.keyboard.press('ArrowDown');
  await bp.clock.runFor(500);
  check(!(await busy()), 'busy background cleared once converged');
  await bctx.close();
}

// pins at the same position, and a failed solve (their own page, so the main session is untouched)
function uiState(np) {
  return np.evaluate(() => ({
    status: document.getElementById('status').textContent,
    tip: document.getElementById('statusInfo').dataset.tip,
    len: document.getElementById('rLen').textContent,
    dashed: Boolean(document.querySelector('#strip-layer path[stroke-dasharray]')),
    msg: document.getElementById('ioMsg').textContent,
  }));
}
const stripInSVG = (np) =>
  np.evaluate(() =>
    /id="strip-(outline|centreline)"/.test(
      __jig.buildSVG(new Set(['pins', 'strip-outline', 'strip-centreline'])),
    ),
  );

async function samePosition(np) {
  const example = [
    [60, 300],
    [170, 205],
    [300, 175],
    [420, 235],
    [540, 140],
  ].map(([x, y]) => [x, y, 'through']);
  const load = (pts, sel) =>
    np.evaluate(
      ([list, selected]) =>
        __jig.restore({
          settings: { W: 600, H: 400 },
          pins: list.map(([x, y, mode], i) => ({ id: i + 1, x, y, mode })),
          selected,
        }),
      [pts, sel],
    );
  // a pin typed onto its neighbour: the two act as one pin
  await load(
    example.filter((_, i) => i !== 3),
    null,
  );
  const one = await idle(np);
  const lenOne = await np.evaluate(() => __jig.res.length);
  await load(example, 4);
  await idle(np);
  await np.fill('#inPX', '300');
  await np.press('#inPX', 'Enter');
  await idle(np);
  await np.fill('#inPY', '175');
  await np.press('#inPY', 'Enter');
  let st = await idle(np);
  let u = await uiState(np);
  const len = await np.evaluate(() => __jig.res.length);
  check(
    st === one && Math.abs(len - lenOne) < 1e-6 * lenOne,
    `pin typed onto its neighbour acts as one pin: ${st}, ${len} vs ${lenOne} mm`,
  );
  check(
    /· 1 warning/.test(u.status) && /Pins 3 and 4: same position/.test(u.tip),
    `same-position warning: ${u.status}`,
  );
  // Auto onto Through cannot share a contact: reported, no strip readouts or export
  await np.evaluate(() => {
    __jig.state.selected = 3;
  });
  await np.click('#mAuto');
  st = await idle(np);
  u = await uiState(np);
  check(
    st === 'invalid' &&
      u.status === 'Pins on top of each other' &&
      /Pins 3 and 4 are at the same position, but one is a Through pin/.test(u.tip),
    `incompatible pins at one position: ${u.status}`,
  );
  check(
    u.len === '–' && u.dashed && !(await stripInSVG(np)),
    `no readouts, dashed strip, no strip in the SVG: ${JSON.stringify(u).slice(0, 120)}`,
  );
  await np.keyboard.press('Control+z');
  check((await idle(np)) === one, 'undo makes it valid again');
}

// a failed solve: the dashed earlier shape, no readouts, the SVG without the strip
async function failedSolve(np) {
  await np.evaluate(() => {
    document.activeElement.blur();
    __jig.state.selected = 2;
    const sv = __jig.solver;
    sv.__it = sv._iterate;
    sv._iterate = function fail() {
      this.mu = 1e14;
      return 'rejected';
    };
  });
  await np.keyboard.press('ArrowUp');
  let st = await idle(np);
  let u = await uiState(np);
  check(
    st === 'failed' &&
      u.len === '–' &&
      u.dashed &&
      /dashed strip is the shape from before your last change/.test(u.tip),
    `failed: dashed earlier shape, no readouts: ${JSON.stringify(u).slice(0, 160)}`,
  );
  await np.click('details[data-sec="io"] > summary');
  const [dl] = await Promise.all([np.waitForEvent('download'), np.click('#btnExport')]);
  const svg = fs.readFileSync(await dl.path(), 'utf8');
  const msg = (await uiState(np)).msg;
  check(
    !/id="strip-/.test(svg) &&
      /<desc>The strip is not included/.test(svg) &&
      /Downloaded the pins only/.test(msg),
    'failed: the SVG has the pins only, and says so',
  );
  await np.evaluate(() => {
    const sv = __jig.solver;
    sv._iterate = sv.__it;
    delete sv.__it;
  });
  await np.keyboard.press('ArrowDown');
  st = await idle(np);
  u = await uiState(np);
  check(
    st === 'converged' && u.len !== '–' && !u.dashed && (await stripInSVG(np)),
    `the next edit solves again: ${st}`,
  );
}

// a Left/Right pin the strip does not touch: a warning, not a clean "Converged"
async function releasedPin(np) {
  const load = (side) =>
    np.evaluate(
      (m) =>
        __jig.restore({
          settings: { W: 600, H: 400 },
          pins: [
            [60, 200, 'auto'],
            [300, 150, 'auto'],
            [420, 180, m],
            [540, 200, 'auto'],
          ].map(([x, y, mode], i) => ({ id: i + 1, x, y, mode })),
          selected: null,
        }),
      side,
    );
  const look = () =>
    np.evaluate(() => ({
      cls: document.getElementById('status').className,
      problem: document.getElementById('stage').classList.contains('problem'),
      engaged: __jig.solver.result().pins[2].engaged,
    }));
  await load('right');
  let st = await idle(np);
  let u = await uiState(np);
  let l = await look();
  check(
    st === 'converged' &&
      !l.engaged &&
      /1 warning/.test(u.status) &&
      l.cls === 'bad' &&
      l.problem &&
      /Pin 3: released/.test(u.tip),
    `released pin: a warning, not green: ${JSON.stringify({ st, ...u, ...l }).slice(0, 200)}`,
  );
  await load('left');
  st = await idle(np);
  u = await uiState(np);
  l = await look();
  check(
    st === 'converged' && l.engaged && u.status === 'Converged' && l.cls === 'ok' && !l.problem,
    `touching pin: clean status: ${JSON.stringify({ st, ...u, ...l }).slice(0, 200)}`,
  );
}

// project files: repaired where harmless, refused where the design would change
async function projectFiles(np) {
  const proj = (o) =>
    `<svg xmlns="http://www.w3.org/2000/svg"><metadata id="spring-strip-project"><![CDATA[${JSON.stringify(o)}]]></metadata></svg>`;
  const open = async (name, o) => {
    await np.evaluate(() => {
      document.getElementById('ioMsg').textContent = '';
    });
    await np.evaluate(([n, text]) => __jig.openText(n, text), [name, proj(o)]);
    await idle(np);
    return np.evaluate(() => ({
      msg: document.getElementById('ioMsg').textContent,
      pins: __jig.state.pins.map((p) => [p.id, p.x, p.y, p.mode]),
    }));
  };
  let o = await open('text.svg', {
    v: 1,
    settings: { W: '600', H: 400, tauHat: 1 },
    pins: [
      { id: 1, x: '100', y: '200', mode: 'auto' },
      { id: 1, x: 300, y: '150' },
      { x: 500, y: 200, mode: 'through' },
    ],
  });
  const repaired = JSON.stringify([
    [1, 100, 200, 'auto'],
    [2, 300, 150, 'auto'],
    [3, 500, 200, 'through'],
  ]);
  check(
    /Opened text\.svg: 3 pins/.test(o.msg) && JSON.stringify(o.pins) === repaired,
    `numbers as text and repeated ids are repaired: ${o.msg} ${JSON.stringify(o.pins)}`,
  );
  await np.keyboard.press('ArrowRight');
  check((await idle(np)) !== 'timeout', 'and the pins can be nudged');
  const two = [
    { id: 1, x: 0, y: 0 },
    { id: 2, x: 100, y: 0 },
  ];
  const refused = [
    [
      'mode.svg',
      { pins: [{ id: 1, x: 0, y: 0, mode: 'sideways' }, two[1]] },
      /pin 1 has an unknown mode "sideways"/,
    ],
    ['pos.svg', { pins: [{ id: 1, x: 'left', y: 0 }, two[1]] }, /pin 1 has no valid position/],
    ['set.svg', { settings: { d: -6 }, pins: two }, /the setting d is not valid/],
    ['new.svg', { v: 2, pins: two }, /newer version/],
  ];
  for (const [name, bad, why] of refused) {
    o = await open(name, bad);
    check(why.test(o.msg) && o.pins.length === 3, `${name} refused (${o.msg}), pins unchanged`);
  }
}

async function ownPage(browser, errors, fn) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const np = await ctx.newPage();
  np.on('pageerror', (e) => errors.push(e.message));
  await np.goto(FILE);
  await ready(np);
  await fn(np);
  await ctx.close();
}

// persistence across reload
async function persistence(page, h) {
  await page.click('details[data-sec="settings"] > summary'); // close Settings; Import/export is open
  // saved: the project (autosave is debounced) and the sections (the toggle event comes later)
  await page.waitForFunction(() => {
    const s = localStorage.getItem('springStripJig.v1');
    const sec = JSON.parse(localStorage.getItem('springStripJig.sections') || '{}');
    return (
      Boolean(s) && JSON.parse(s).pins.length === __jig.state.pins.length && sec.settings === false
    );
  });
  await page.reload();
  await ready(page);
  check((await h.J()).pins.length === 7, 'autosave restores the last session');
  const sections = await h.sections();
  check(
    JSON.stringify(sections) === JSON.stringify({ settings: false, help: false, io: true }),
    `open sections remembered: ${JSON.stringify(sections)}`,
  );
}

test('spring-tool.html in Chromium', async (t) => {
  const browser = await chromium.launch();
  const errors = [];
  try {
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      acceptDownloads: true,
    });
    const page = await ctx.newPage();
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(FILE);
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await ready(page);
    const h = helpers(page);
    const shared = {}; // values one step leaves for a later one
    await step(t, 'the example', () => initialExample(page, h));
    await step(t, 'sidebar: sections, fixed layout, tooltips', () => sidebar(page, h));
    await step(t, 'add a pin by dragging, undo and redo', () => addAndDrag(page, h));
    await step(t, 'insert into a stretch, move a pin', () => insertAndMove(page, h));
    await step(t, 'modes: double-click, keys and buttons', () => modes(page, h));
    await step(t, 'problem background, minimum radius', () => problemBackground(page, h));
    await step(t, 'numeric edit and deleting pins', () => editAndDelete(page, h));
    await step(t, 'zoom, grid and panning', () => zoomAndPan(page, h, shared));
    await step(t, 'SVG export and open', () => svgExportAndOpen(page, h));
    await step(t, 'TSV export and open', () => tsvExportAndOpen(page, h));
    await step(t, 'F fits the work area, then the pins', () => fitKeys(page, h, shared));
    await step(t, 'background image', () => backgroundImage(page));
    await step(t, 'room scale', () => roomScale(page, h));
    await step(t, 'touch: add a pin, pinch', () => touch(browser, errors));
    await step(t, 'busy background for a slow solve', () => busyBackground(browser, errors));
    await step(t, 'pins at the same position', () => ownPage(browser, errors, samePosition));
    await step(t, 'a failed solve', () => ownPage(browser, errors, failedSolve));
    await step(t, 'a released Left/Right pin', () => ownPage(browser, errors, releasedPin));
    await step(t, 'project files that need repair or are refused', () =>
      ownPage(browser, errors, projectFiles),
    );
    await step(t, 'autosave and remembered sections', () => persistence(page, h));
    await step(t, 'no console errors', () =>
      check(errors.length === 0, `console errors: ${errors.join(' | ')}`),
    );
  } finally {
    await browser.close();
    console.log(`\n${passes} checks passed, ${failures} failed`);
  }
});
