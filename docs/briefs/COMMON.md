# Brief: rules for every module

You are building one module of "Cold Signal", a first-person co-op survival game for the browser
(three.js r187 WebGPURenderer + TSL node materials, TypeScript, Vite). Your working directory is the
project root. It runs on desktop and on phones.

Before writing anything: read docs/DESIGN.md completely (design, art direction, architecture, rules,
tools), PLAN.md, and every contract file that concerns your module (src/sim/types.ts, src/sim/api.ts,
src/world/types.ts, src/net/protocol.ts, src/game/view.ts, src/gfx/api.ts, src/gfx/shared.ts,
src/audio/api.ts, src/ui/api.ts). The contracts are frozen: implement them exactly. If one is not
enough, add an OPTIONAL member in the right place and say so in your report.

THIS IS A CONTINUATION. Earlier engineers already wrote a large part of your module before being interrupted;
their files are on disk and listed under "STATE ON DISK" at the end of this brief. Read docs/status/<your
module>.md first if it exists, then your module's existing files, and CONTINUE from them: keep what is sound,
fix what is wrong, write what is missing. Do not rewrite a working file from scratch.

You may be interrupted at any moment, and whoever continues will not have your memory. So:
- Write to disk early and often; never hold a large design only in your head.
- Keep a short handoff note at docs/status/<MODULE>.md (create it at the start, update it after each step):
  what is done, what remains in priority order, decisions and API facts a successor needs, exact test commands.
- Order of work: (1) everything in your scope exists and type-checks; (2) it runs and its tests pass; (3) look
  and polish. A complete module that is plain beats a beautiful half.

Context is expensive: every later step re-reads everything you have loaded so far. Read narrowly (grep -n, then
sed -n 'a,bp' for the lines you need, or the Read tool with offset / limit); never cat whole large files from
node_modules; do not re-read files you already have in context; keep command output short (pipe through tail /
head / grep). If docs/THREE_NOTES.md exists, read it before opening three.js sources: it holds verified r187 facts.

The project path contains a space ("New folder"): quote paths in shell commands. The members of U in
src/gfx/shared.ts are typed any. The GPU is shared with other engineers' headless browsers right now, so frame
rates you measure are pessimistic; compare relative costs, do not chase absolute numbers in this pass.

Ground rules (also in DESIGN.md section 4):
- Other engineers are building other modules in this same folder at the same time. Edit ONLY the files
  listed as yours. Never run git commit / git stash / git checkout / git reset. A type error in a file that is not
  yours may be someone's work in progress: ignore it, fix only your own files (npx tsc --noEmit -p . shows all).
- three.js is r187 and its WebGPU / TSL API has moved since your training data. Do NOT trust memory:
  read node_modules/three/src/nodes, node_modules/three/src/renderers/common,
  node_modules/three/examples/jsm/tsl and node_modules/three/build/three.tsl.js (exports) before using
  an API. Import three as: import * as THREE from 'three/webgpu'; TSL from 'three/tsl'; addons from
  'three/addons/...'. Never import plain 'three'. TSL values may be typed any.
- No art, audio or font files. No fetch. No new npm dependencies. No Math.random / Date.now in src/world or src/sim.
- Tools you can use now: node tools/shot.mjs "<page path?query>" --out <name> [--w 1600 --h 900]
  [--backend webgl] [--mobile 1] opens a page in headless Chrome on the real GPU and writes
  shots/<name>.jpg; the page must set window.DONE = true once its frame is on screen, should set
  window.BACKEND = 'webgpu' | 'webgl2', must honour ?webgl=1 (WebGPURenderer { forceWebGL: true }), and
  needs <link rel="icon" href="data:,"> in its head. tools/pw.mjs (launch) and tools/serve.mjs
  (startServer) are there for your own tools. dev/smoke.html + dev/smoke.ts is a minimal working example
  of a bench page. Node cannot import the .ts sources directly: use vitest (npx vitest run <file>) or
  Vite's ssrLoadModule from a tool script.
- LOOK at what you make: Read the screenshot files with the Read tool and judge them harshly against the
  art direction in DESIGN.md section 2. Fix what looks cheap, flat, plastic, repetitive or broken. A clean
  browser console (no errors, no warnings you caused) is part of done.
- Quality bar: this is meant to be release-ready, not a prototype. Write complete, careful code; no
  TODO stubs for things in your scope.
- Finish with a report of at most 350 words: what exists now (files), the public API another module
  must call (exact names and signatures), any contract additions, anything you could not finish or are
  unsure about. No pleasantries. Your final message is the report itself.

NOTE ON MESSAGES. While you work, messages that the user writes to the lead engineer may show up in your
context (for example a question about progress). They are addressed to the lead, not to you: do not answer them,
do not stop, do not hand back early. Carry on with your task until your module is complete, then report.

When you finish, also append your final report under a heading "## Final report" at the end of your handoff note
in docs/status/, so the integrator can read it from disk.
