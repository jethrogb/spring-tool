# Spring strip jig

A browser tool for designing bending jigs. You place pins on a flat work
surface, and a springy strip (a batten, lath or spring-steel bar) bends around
them. The strip's shape comes from simulating the physics of an elastic strip.
The result can be downloaded as an SVG drawing at scale. The drawing includes
the strip only once it has settled for the current pins; otherwise it has the
pins only, and says why.

The whole tool is one self-contained file,
[`docs/index.html`](https://jethrogb.github.io/spring-tool/). It has no
dependencies, works offline, and runs in any modern browser.

## How it works

### Physical model

The strip is an inextensible elastic line (an elastica). Its shape minimises
the bending energy ∫κ² ds, where κ is the curvature and s the length along the
strip.

- **Frictionless pins:** the strip slides freely past the pins, so the length
  of each stretch between pins is free.
- **Free ends:** the ends carry no load and stay straight beyond the end pins;
  that straight part is the overhang.
- **Contact geometry:**
  - **Touching an edge** (Auto, Left, Right): the centreline passes the pin
    tangentially, at r_eff = pin diameter / 2 + strip thickness / 2 from the
    pin centre.
  - **Through:** the centreline passes through the pin centre exactly.
- **Contact forces:** they come out of the solution as Lagrange multipliers
  (the internal force in each stretch). A pin's side is chosen, or a Left/Right
  pin released, from the sign of its force:
  - **Auto** pins take whichever side lets the pin *push*.
  - **Left/Right** pins are released when they would *pull*, and touch again
    when the strip cuts into them.
  - Hysteresis and a "marginal" freeze stop contacts from flipping back and
    forth.
- **Pins at the same position:**
  - **Neighbouring pins** at the same position act as one pin, with a warning.
    A stretch between them would have no length.
  - **Sharing a contact:** Through pins can share only with Through pins, and a
    Left pin cannot share with a Right one. Such pins are reported as on top of
    each other, and nothing is solved.
  - **Overlapping pins**, closer than the pin diameter, get a warning.

### Layouts with no resting shape

On frictionless pins, some layouts have no equilibrium at all. A deep V or a
tight hairpin, for example, makes the strip slide out between the pins forever.
A real strip is held by friction. The tool models this with a length cap:

- **The cap:** the contact-to-contact length may not exceed the length limit
  (default 2) × the summed pin-to-pin distances.
- **While held:** the cap's multiplier is the tension that friction at the end
  pins must supply. The tool reports the friction coefficient needed, and the
  status reads "Would slide out, held".
- **Choosing the held length:** it is a modelling choice, so the tool picks the
  one that keeps your pins in contact. That is the longest length, up to the
  cap, at which every Left/Right pin still pushes, found by bisection.
- **Release:** the cap lets go as soon as the strip would rather be shorter.

### Shape depends on the layout, not the history

Following edits incrementally can leave the strip in a poor equilibrium, for
example looped while held, or snapped off pins that later come back.

- **Fresh re-solve:** in those cases the solver also solves the layout from
  scratch, with every pin touching. If that is not valid, it also tries with
  the interior Left/Right pins released.
- **Choosing a result:** it keeps the better one: a stable shape first (see
  below), then a valid one (no Left/Right pin pulling), then more pins in
  contact, then not held, then lower bending energy.
- **Smooth dragging:** the extra work is spread over animation frames, so
  dragging stays smooth.

### Unstable equilibria

Newton's method finds any equilibrium, also an unstable one: a saddle, which a
real strip leaves at the slightest push. Near the slide-out limit of a hairpin,
for example, the compact shape found first is one.

- **The check:** before a shape becomes the result, the solver counts the
  negative eigenvalues of the KKT matrix, from the sign of its determinant in
  the band LU. A stable shape has as many as there are constraints. The parity
  of the count catches the usual case, a single unstable direction.
- **Leaving it:** shift-invert Lanczos with the same factorisation, then
  shifted inverse iteration, finds the unstable direction. The shape is pushed
  a little along it, downhill, and Newton carries on. After three pushes per
  edit the shape is kept and flagged unstable.

### When there is no answer

If the solver fails, the last good shape stays on screen, dashed and without
readouts. The status tooltip says whether it was for an earlier layout. A
downloaded drawing then has the pins only.

### Discretisation and solver

The solver (`src/solver.js`) is specific to this problem and has no
dependencies. General-purpose options were considered and rejected:

- **Spiro / Euler-spiral splines** are curve design, not physics, and have no
  contact forces.
- **Generic constrained optimisers** (NLopt, Ceres compiled to WASM) would still
  need all the problem-specific parts, and are slower on this banded problem.
- **Physics engines** (chains of links joined by angular springs) jitter, settle
  slowly, and give an inaccurate shape.

**Discretisation:**
- **Stretches:** each stretch between touching pins is split into m equal
  segments, described by their angles θ and a common segment length h.
- **Segment count:** m is chosen for about 3° of turn per segment, kept between
  8 and 64. A stretch is refined or coarsened after convergence, with a
  hysteresis band.
- **Unknowns:** the angles, one length per stretch, and two multipliers per
  stretch (closing the stretch onto its contact points).
- **Ordering:** the unknowns are stored stretch by stretch, so the system
  matrix is banded.

**Newton's method:**
- **Exact derivatives:** each step uses exact second derivatives, including the
  dependence of each contact point on the strip direction there.
- **Linear solve:** a banded LU with partial pivoting, because the system is
  indefinite (a stretch under compression can buckle). The LU tracks each row's
  extent, which skips work.
- **Damping:** Marquardt damping, plus backtracking on the step length.
- **Step test:** a step must reduce an exact-penalty merit function. A
  second-order correction fixes the constraint error that large rotations of
  long stretches leave behind (the Maratos effect).
- **Length cap:** when the cap is active, it is added as a bordered row. That
  takes two extra solves with the same factorisation.
- **Driving the UI:** the browser gives the solver about 8 ms per animation
  frame, so the strip visibly springs to its new shape while you drag. It
  checks the time between Newton iterations, and does not start one (or the
  stability check, which costs about as much) that it expects to overrun. A
  frame takes longer only when a single iteration does: about 12–15 ms at 100
  pins.

**Scale independence:** inside the solver every length is divided by L_ref, the
summed pin-to-pin distance, and y points up. Every tolerance and limit is
therefore a pure number. A design 0.01×, 1× or 100× the size gives the same
shape in the same number of iterations, and the grid, rulers and hit-testing
work the same from millimetre details to a 6 m room.

## Project layout

```
src/solver.js        the solver: no DOM access, runs in the browser and in Node
src/app.js           the page's code: drawing, input, panel, files
src/template.html    page and styles; the //@SOLVER@ and //@APP@ lines mark where the code goes
scripts/build.js     inlines the solver and the app code into the template, writes spring-tool.html
test/                solver, drag-sweep and browser tests (node:test)
test/fixtures/       drags that once failed on other sweep seeds, replayed as regression cases
eslint.config.js     lint rules: ESLint's recommended set plus the Airbnb/Google quality rules
spring-tool.html     the built tool (generated)
```

## Building and testing

Requires Node.js 18.18 or later.

```
npm install          # once: installs Playwright, ESLint and Prettier, downloads Chromium
npm run build        # writes spring-tool.html
npm test             # builds, then runs all three test suites
npm run lint         # ESLint, and Prettier's check of the layout
npm run format       # lays out the code with Prettier
```

The tests run on Node's built-in `node:test`. Their checks are soft: a test
reports every failing check, then fails.

| Script | What it checks |
|---|---|
| `npm run test:solver` | ~790 checks of the solver: the banded LU against dense elimination, the symmetric 3-point bend (mirror symmetry, forces, sign conventions), agreement with linear beam theory for small deflections, scale invariance, room scale, contact geometry, Left/Right release and re-engaging, slide-out holds, refinement, random layouts, Through pins, pins at the same position (every pair of modes), stability (checked independently, by the inertia of the dense KKT matrix), failed solves, the round limit, the frame budget, work targets for layouts that slide out (hairpins and a deep V: iterations to settle, to show the held shape, and searches for an unstable direction), and regression cases from real use. The work checks count Newton iterations, so they do not depend on the machine; `PERF=1` also checks times. |
| `npm run test:sweep` | 60 random layouts with one pin dragged far (across the strip, out of order, through other pins), the way the UI drives the solver. Every drag must settle on a valid shape without NaN. It is deterministic: each move gets a fixed number of Newton iterations. Options: `-- --trials N --seed S --only K --steps-iter I --verbose`; `--save-failures DIR` writes each failing drag as a JSON case (the layout before the drag, the settings and the drag), and `--case FILE` replays one exactly. The cases in `test/fixtures/sweep-cases/`, drags from other seeds that once failed, are replayed on every run and must settle too; save a new one there with `--save-failures test/fixtures/sweep-cases`. |
| `npm run test:browser` | ~100 checks in headless Chromium: adding, dragging, inserting and deleting pins, modes, keys, panning and zooming, undo, the sidebar layout not jumping, tooltips, status colours, SVG and TSV export and import, the background image, room scale, touch pinch, autosave, pins at the same position, a failed solve, and project files that need repair or are refused. It waits on conditions rather than fixed delays, and runs the busy-background check on Playwright's clock. |
