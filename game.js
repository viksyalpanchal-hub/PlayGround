import * as THREE from './three.module.js';

/* ============================================================
   TEMPLE DASH 3D — a Temple-Run-like endless runner
   Straight endless track, 3 lanes, swipe/tap/keyboard controls.
   ============================================================ */

// ---------------- Tuning ----------------
const LANES = [-2.3, 0, 2.3];
const TRACK_HALF = 4.0;
const SEG_LEN = 10;
const SEG_COUNT = 22;           // ~220 m of visible track
const SPAWN_AHEAD = 190;
const GRAVITY = -26;
const JUMP_V = 9.2;
const SLIDE_TIME = 0.75;
const LANE_SPEED = 13;
const BASE_SPEED = 10;
const MAX_SPEED = 30;
const BEST_KEY = 'temple-dash-best';

// ---------------- Small helpers ----------------
const rand = (a, b) => a + Math.random() * (b - a);
const randInt = (a, b) => Math.floor(rand(a, b + 1));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function makeCanvasTexture(size, draw) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d'), size);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// ---------------- Audio (procedural, no assets) ----------------
const AudioSys = {
  ctx: null, muted: false, drumTimer: null, step: 0,
  init() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    try { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch { /* no audio */ }
  },
  tone(freq, dur, type = 'sine', vol = 0.2, slideTo = null, delay = 0) {
    if (!this.ctx || this.muted) return;
    const t0 = this.ctx.currentTime + delay;
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t0);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
    g.gain.setValueAtTime(vol, t0);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    o.connect(g).connect(this.ctx.destination);
    o.start(t0); o.stop(t0 + dur + 0.02);
  },
  noise(dur = 0.3, vol = 0.25, delay = 0) {
    if (!this.ctx || this.muted) return;
    const t0 = this.ctx.currentTime + delay;
    const len = Math.floor(this.ctx.sampleRate * dur);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const s = this.ctx.createBufferSource(); s.buffer = buf;
    const g = this.ctx.createGain(); g.gain.value = vol;
    const f = this.ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 900;
    s.connect(f).connect(g).connect(this.ctx.destination);
    s.start(t0);
  },
  coin() { this.tone(990, 0.08, 'square', 0.08); this.tone(1485, 0.16, 'square', 0.08, null, 0.07); },
  jump() { this.tone(280, 0.22, 'sine', 0.18, 720); },
  slide() { this.noise(0.25, 0.15); this.tone(180, 0.2, 'sawtooth', 0.06, 90); },
  lane() { this.tone(420, 0.07, 'triangle', 0.12, 560); },
  crash() { this.noise(0.5, 0.4); this.tone(160, 0.5, 'sawtooth', 0.25, 40); },
  power() { [523, 659, 784, 1046].forEach((f, i) => this.tone(f, 0.14, 'square', 0.1, null, i * 0.08)); },
  click() { this.tone(660, 0.06, 'triangle', 0.12); },
  startDrums() {
    this.stopDrums();
    this.drumTimer = setInterval(() => {
      if (!this.ctx || this.muted || state !== 'playing') return;
      this.step++;
      if (this.step % 2 === 0) this.tone(70, 0.14, 'sine', 0.22, 40);      // kick
      if (this.step % 4 === 2) this.noise(0.06, 0.06);                      // hat
      if (this.step % 8 === 6) this.tone(200, 0.1, 'triangle', 0.08, 120);  // tom
    }, 170);
  },
  stopDrums() { if (this.drumTimer) { clearInterval(this.drumTimer); this.drumTimer = null; } },
};

// ---------------- DOM ----------------
const $ = (id) => document.getElementById(id);
const canvas = $('game-canvas');
const hud = $('hud'), scoreEl = $('score'), hudBestEl = $('hud-best'), coinEl = $('coin-count');
const powerBar = $('power-bar');
const menuEl = $('menu'), pauseEl = $('pause-menu'), overEl = $('gameover');
const touchUI = $('touch-controls');
if ('ontouchstart' in window || navigator.maxTouchPoints > 0) touchUI.classList.remove('hidden');

// ---------------- Game state ----------------
let state = 'menu';           // menu | playing | paused | dying | over
let distance = 0, coinCount = 0, score = 0, speed = BASE_SPEED;
let best = Number(localStorage.getItem(BEST_KEY) || 0);
let deathCause = '', deathTimer = 0;
let magnetT = 0, shieldT = 0, boostT = 0;
let nextSpawnZ = 30, nextPowerZ = 200;
let shake = 0;
$('menu-best').textContent = best;
hudBestEl.textContent = best;

// ---------------- Renderer / scene ----------------
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
} catch {
  $('webgl-error').classList.remove('hidden');
  throw new Error('WebGL unavailable');
}
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0xe8a35c, 45, 175);

const camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.1, 400);

// Sunset sky gradient
{
  const tex = makeCanvasTexture(256, (g, s) => {
    const gr = g.createLinearGradient(0, 0, 0, s);
    gr.addColorStop(0, '#1b1440');
    gr.addColorStop(0.45, '#5b2a6e');
    gr.addColorStop(0.72, '#e8703a');
    gr.addColorStop(0.88, '#ffcf7a');
    gr.addColorStop(1, '#ffe9b8');
    g.fillStyle = gr; g.fillRect(0, 0, s, s);
  });
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(340, 16, 12),
    new THREE.MeshBasicMaterial({ map: tex, side: THREE.BackSide, fog: false, depthWrite: false })
  );
  sky.renderOrder = -10;
  scene.add(sky);
  sky.onBeforeRender = () => { sky.position.copy(camera.position); };
}
// Sun disc + clouds
{
  const sunTex = makeCanvasTexture(128, (g, s) => {
    const gr = g.createRadialGradient(s/2, s/2, 4, s/2, s/2, s/2);
    gr.addColorStop(0, 'rgba(255,250,220,1)');
    gr.addColorStop(0.35, 'rgba(255,220,150,1)');
    gr.addColorStop(1, 'rgba(255,180,100,0)');
    g.fillStyle = gr; g.fillRect(0, 0, s, s);
  });
  const sun = new THREE.Sprite(new THREE.SpriteMaterial({ map: sunTex, fog: false, depthWrite: false }));
  sun.scale.set(90, 90, 1);
  scene.add(sun);
  sun.onBeforeRender = () => { sun.position.set(camera.position.x, 26, camera.position.z - 300); };
}
const clouds = [];
{
  const cm = new THREE.MeshBasicMaterial({ color: 0xffd9c0, transparent: true, opacity: 0.85, fog: false });
  const cg = new THREE.SphereGeometry(1, 8, 6);
  for (let i = 0; i < 10; i++) {
    const grp = new THREE.Group();
    for (let j = 0; j < 4; j++) {
      const m = new THREE.Mesh(cg, cm);
      m.position.set(j * rand(3, 5) - 7, rand(-0.5, 0.5), rand(-1, 1));
      m.scale.set(rand(3, 6), rand(1, 1.8), rand(2, 3));
      grp.add(m);
    }
    grp.position.set(rand(-140, 140), rand(35, 70), 0);
    grp.userData.z = rand(-40, 200);
    scene.add(grp); clouds.push(grp);
  }
}

// Lights
scene.add(new THREE.HemisphereLight(0xffd9b0, 0x3a5f2a, 0.95));
const sunLight = new THREE.DirectionalLight(0xffb36b, 1.6);
sunLight.position.set(-30, 50, -40);
scene.add(sunLight);
const fillLight = new THREE.DirectionalLight(0x6a7cff, 0.35);
fillLight.position.set(20, 30, 40);
scene.add(fillLight);
// Camera-side fill so the runner reads clearly against the sunset
const charLight = new THREE.DirectionalLight(0xffe8c8, 0.85);
scene.add(charLight);

// ---------------- Procedural textures ----------------
const stoneTex = makeCanvasTexture(256, (g, s) => {
  g.fillStyle = '#8d8577'; g.fillRect(0, 0, s, s);
  for (let i = 0; i < 900; i++) {
    g.fillStyle = `rgba(${randInt(90,150)},${randInt(85,140)},${randInt(70,120)},0.25)`;
    g.fillRect(rand(0, s), rand(0, s), rand(1, 4), rand(1, 4));
  }
  g.strokeStyle = 'rgba(40,32,24,0.55)'; g.lineWidth = 4;
  for (let i = 0; i <= 4; i++) {
    g.beginPath(); g.moveTo(0, (i * s) / 4); g.lineTo(s, (i * s) / 4); g.stroke();
    g.beginPath(); g.moveTo((i * s) / 4, 0); g.lineTo((i * s) / 4, s); g.stroke();
  }
  g.strokeStyle = 'rgba(255,240,210,0.18)'; g.lineWidth = 2;
  for (let i = 0; i <= 4; i++) {
    g.beginPath(); g.moveTo(0, (i * s) / 4 + 3); g.lineTo(s, (i * s) / 4 + 3); g.stroke();
  }
});
stoneTex.repeat.set(2, 3);
const grassTex = makeCanvasTexture(256, (g, s) => {
  g.fillStyle = '#4a7c2f'; g.fillRect(0, 0, s, s);
  for (let i = 0; i < 1600; i++) {
    g.fillStyle = `rgba(${randInt(50,110)},${randInt(110,170)},${randInt(40,80)},0.5)`;
    g.fillRect(rand(0, s), rand(0, s), 2, rand(2, 6));
  }
});
grassTex.repeat.set(4, 4);
const wallTex = makeCanvasTexture(256, (g, s) => {
  g.fillStyle = '#7a6a52'; g.fillRect(0, 0, s, s);
  g.fillStyle = 'rgba(60,90,40,0.35)';
  for (let i = 0; i < 40; i++) g.fillRect(rand(0, s), rand(0, s), rand(4, 20), rand(3, 10));
  g.strokeStyle = 'rgba(30,22,14,0.6)'; g.lineWidth = 3;
  const rows = 4;
  for (let r = 0; r <= rows; r++) {
    g.beginPath(); g.moveTo(0, (r * s) / rows); g.lineTo(s, (r * s) / rows); g.stroke();
    for (let cx = 0; cx < 4; cx++) {
      const x = ((cx + (r % 2 ? 0.5 : 0)) * s) / 4;
      g.beginPath(); g.moveTo(x, ((r - 1) * s) / rows); g.lineTo(x, (r * s) / rows); g.stroke();
    }
  }
});

// ---------------- Shared materials / geometry ----------------
const M = {
  stone: new THREE.MeshStandardMaterial({ map: stoneTex, roughness: 0.95 }),
  grass: new THREE.MeshStandardMaterial({ map: grassTex, roughness: 1 }),
  wall: new THREE.MeshStandardMaterial({ map: wallTex, roughness: 0.95 }),
  pillar: new THREE.MeshStandardMaterial({ color: 0x9a8a6a, roughness: 0.9 }),
  pillarTop: new THREE.MeshStandardMaterial({ color: 0x6e5c40, roughness: 0.9 }),
  wood: new THREE.MeshStandardMaterial({ color: 0x6b4423, roughness: 0.85 }),
  woodDark: new THREE.MeshStandardMaterial({ color: 0x4a2d15, roughness: 0.9 }),
  rock: new THREE.MeshStandardMaterial({ color: 0x7d7a72, roughness: 1, flatShading: true }),
  leaf: new THREE.MeshStandardMaterial({ color: 0x2e6b24, roughness: 1, flatShading: true }),
  leaf2: new THREE.MeshStandardMaterial({ color: 0x3f8f2e, roughness: 1, flatShading: true }),
  trunk: new THREE.MeshStandardMaterial({ color: 0x5a3a20, roughness: 1 }),
  gold: new THREE.MeshStandardMaterial({ color: 0xffc93c, metalness: 0.85, roughness: 0.25, emissive: 0x7a4d00, emissiveIntensity: 0.6 }),
  obstacleStone: new THREE.MeshStandardMaterial({ color: 0x8a7f6a, roughness: 0.9 }),
  moss: new THREE.MeshStandardMaterial({ color: 0x4d7a2e, roughness: 1 }),
  flame: new THREE.MeshBasicMaterial({ color: 0xff7b1c }),
  flameCore: new THREE.MeshBasicMaterial({ color: 0xffe27a }),
  lava: new THREE.MeshBasicMaterial({ color: 0xff4d00 }),
  blade: new THREE.MeshStandardMaterial({ color: 0xb9c2cc, metalness: 0.9, roughness: 0.3 }),
  bladePole: new THREE.MeshStandardMaterial({ color: 0x3d3d4a, metalness: 0.6, roughness: 0.5 }),
  shield: new THREE.MeshBasicMaterial({ color: 0x54e0ff, transparent: true, opacity: 0.85 }),
  magnet: new THREE.MeshBasicMaterial({ color: 0xff5d5d }),
  boost: new THREE.MeshBasicMaterial({ color: 0x9d7bff }),
};
const G = {
  box: new THREE.BoxGeometry(1, 1, 1),
  coin: new THREE.TorusGeometry(0.34, 0.13, 10, 20),
  trunk: new THREE.CylinderGeometry(0.22, 0.32, 1.6, 7),
  leaves: new THREE.ConeGeometry(1.3, 2.4, 7),
  rock: new THREE.DodecahedronGeometry(0.8, 0),
  pillar: new THREE.CylinderGeometry(0.45, 0.55, 4.4, 8),
  flame: new THREE.ConeGeometry(0.22, 0.6, 7),
  blade: new THREE.BoxGeometry(0.25, 0.5, 3.4),
};

// ---------------- Track segments (recycled) ----------------
const segments = [];
const trackGroup = new THREE.Group();
scene.add(trackGroup);

function buildDecor() {
  // returns a group with random side decor, rebuilt on recycle
  const grp = new THREE.Group();
  const side = Math.random() < 0.5 ? -1 : 1;
  // trees
  for (let i = 0; i < 3; i++) {
    const tree = new THREE.Group();
    const trunk = new THREE.Mesh(G.trunk, M.trunk);
    trunk.position.y = 0.8;
    tree.add(trunk);
    const lm = Math.random() < 0.5 ? M.leaf : M.leaf2;
    for (let k = 0; k < 2; k++) {
      const c = new THREE.Mesh(G.leaves, lm);
      c.position.y = 2.2 + k * 1.2;
      c.scale.setScalar(1 - k * 0.25);
      tree.add(c);
    }
    tree.position.set(side * rand(7, 16), 0, rand(-SEG_LEN / 2, SEG_LEN / 2));
    tree.scale.setScalar(rand(0.8, 1.6));
    tree.rotation.y = rand(0, 6);
    grp.add(tree);
  }
  // rocks
  for (let i = 0; i < 2; i++) {
    const r = new THREE.Mesh(G.rock, M.rock);
    r.position.set(-side * rand(6, 14), rand(0, 0.2), rand(-SEG_LEN / 2, SEG_LEN / 2));
    r.scale.set(rand(0.5, 1.4), rand(0.4, 1), rand(0.5, 1.4));
    r.rotation.set(rand(0, 3), rand(0, 3), 0);
    grp.add(r);
  }
  return grp;
}

function buildSegment(idx) {
  const grp = new THREE.Group();
  // stone path
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(TRACK_HALF * 2 + 1, SEG_LEN), M.stone);
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = 0;
  grp.add(floor);
  // grass sides (wide)
  for (const s of [-1, 1]) {
    const grass = new THREE.Mesh(new THREE.PlaneGeometry(60, SEG_LEN), M.grass);
    grass.rotation.x = -Math.PI / 2;
    grass.position.set(s * (TRACK_HALF + 0.5 + 30), -0.05, 0);
    grp.add(grass);
    // low side wall
    const wall = new THREE.Mesh(G.box, M.wall);
    wall.scale.set(0.6, 1.0, SEG_LEN);
    wall.position.set(s * (TRACK_HALF + 0.6), 0.5, 0);
    grp.add(wall);
    const cap = new THREE.Mesh(G.box, M.moss);
    cap.scale.set(0.7, 0.15, SEG_LEN);
    cap.position.set(s * (TRACK_HALF + 0.6), 1.05, 0);
    grp.add(cap);
  }
  // pillars every 3rd segment
  if (idx % 3 === 0) {
    for (const s of [-1, 1]) {
      const p = new THREE.Mesh(G.pillar, M.pillar);
      p.position.set(s * (TRACK_HALF + 1.6), 2.2, 0);
      grp.add(p);
      const top = new THREE.Mesh(G.box, M.pillarTop);
      top.scale.set(1.4, 0.4, 1.4);
      top.position.set(s * (TRACK_HALF + 1.6), 4.5, 0);
      grp.add(top);
      // fire bowl + flame
      const bowl = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.25, 0.3, 8), M.woodDark);
      bowl.position.set(s * (TRACK_HALF + 1.6), 4.85, 0);
      grp.add(bowl);
      const flame = new THREE.Mesh(G.flame, M.flame);
      flame.position.set(s * (TRACK_HALF + 1.6), 5.3, 0);
      flame.userData.flicker = Math.random() * 10;
      grp.add(flame);
      grp.userData['flame' + s] = flame;
    }
  }
  // arch gate every 7th
  if (idx % 7 === 3) {
    const beam = new THREE.Mesh(G.box, M.woodDark);
    beam.scale.set(TRACK_HALF * 2 + 4, 0.8, 0.8);
    beam.position.set(0, 5.4, 0);
    grp.add(beam);
    for (const s of [-1, 1]) {
      const post = new THREE.Mesh(G.box, M.wood);
      post.scale.set(0.6, 5.4, 0.6);
      post.position.set(s * (TRACK_HALF + 1.6), 2.7, 0);
      grp.add(post);
    }
  }
  grp.add(buildDecor());
  return grp;
}

for (let i = 0; i < SEG_COUNT; i++) {
  const g = buildSegment(i);
  g.position.z = -i * SEG_LEN + 20; // cover behind start too
  g.userData.index = i;
  trackGroup.add(g);
  segments.push(g);
}
function recycleSegments(pz) {
  for (const g of segments) {
    if (g.position.z + SEG_LEN / 2 < pz - 18) {
      g.position.z += SEG_LEN * SEG_COUNT;
    }
  }
}

// Torch flames flicker
function flickerFlames(t) {
  for (const g of segments) {
    for (const k of ['flame-1', 'flame1']) {
      const f = g.userData[k];
      if (f) f.scale.y = 1 + Math.sin(t * 13 + f.userData.flicker) * 0.25;
    }
  }
}

// ---------------- Player character ----------------
const player = new THREE.Group();
const charParts = {};
{
  const skin = new THREE.MeshStandardMaterial({ color: 0xc98d5e, roughness: 0.8 });
  const shirt = new THREE.MeshStandardMaterial({ color: 0xd8b13a, roughness: 0.85 });
  const pants = new THREE.MeshStandardMaterial({ color: 0x5a3d22, roughness: 0.9 });
  const hatM = new THREE.MeshStandardMaterial({ color: 0x7a5a2e, roughness: 0.9 });
  const packM = new THREE.MeshStandardMaterial({ color: 0x8a2f23, roughness: 0.85 });

  const mk = (w, h, d, mat, x, y, z) => {
    const m = new THREE.Mesh(G.box, mat);
    m.scale.set(w, h, d); m.position.set(x, y, z);
    return m;
  };
  // legs (pivot at hip y=0.9)
  for (const s of [-1, 1]) {
    const hip = new THREE.Group();
    hip.position.set(s * 0.16, 0.9, 0);
    const leg = mk(0.22, 0.9, 0.24, pants, 0, -0.45, 0);
    hip.add(leg);
    player.add(hip);
    charParts[s < 0 ? 'legL' : 'legR'] = hip;
  }
  // torso
  player.add(mk(0.56, 0.62, 0.34, shirt, 0, 1.2, 0));
  // backpack
  player.add(mk(0.4, 0.45, 0.2, packM, 0, 1.25, 0.27));
  // arms (pivot at shoulder y=1.45)
  for (const s of [-1, 1]) {
    const sh = new THREE.Group();
    sh.position.set(s * 0.37, 1.45, 0);
    const arm = mk(0.18, 0.68, 0.2, shirt, 0, -0.3, 0);
    sh.add(arm);
    const hand = mk(0.16, 0.14, 0.16, skin, 0, -0.68, 0);
    sh.add(hand);
    player.add(sh);
    charParts[s < 0 ? 'armL' : 'armR'] = sh;
  }
  // head + hat
  player.add(mk(0.32, 0.32, 0.32, skin, 0, 1.72, 0));
  const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.07, 10), hatM);
  brim.position.set(0, 1.9, 0);
  player.add(brim);
  const topH = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.21, 0.22, 10), hatM);
  topH.position.set(0, 2.02, 0);
  player.add(topH);
  scene.add(player);
  charLight.target = player;
}
// blob shadow
const blob = new THREE.Mesh(
  new THREE.CircleGeometry(0.55, 16),
  new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35, depthWrite: false })
);
blob.rotation.x = -Math.PI / 2;
scene.add(blob);

// shield bubble
const shieldBubble = new THREE.Mesh(
  new THREE.SphereGeometry(1.2, 16, 12),
  new THREE.MeshBasicMaterial({ color: 0x54e0ff, transparent: true, opacity: 0.28, depthWrite: false })
);
shieldBubble.visible = false;
scene.add(shieldBubble);

// ---------------- Player physics state ----------------
const P = {
  lane: 1, x: 0, y: 0, vy: 0,
  sliding: 0, grounded: true,
  runT: 0, tumble: 0,
};
function playerTop() { return P.y + (P.sliding > 0 ? 0.85 : 1.95); }
function playerBottom() { return P.y + (P.sliding > 0 ? 0.15 : 0); }

function doJump() {
  if (state !== 'playing') return;
  if (P.grounded) {
    P.vy = JUMP_V; P.grounded = false; P.sliding = 0;
    AudioSys.jump();
    if (navigator.vibrate) navigator.vibrate(12);
  }
}
function doSlide() {
  if (state !== 'playing') return;
  if (!P.grounded) { P.vy = Math.min(P.vy, -16); } // slam down
  if (P.sliding <= 0) AudioSys.slide();
  P.sliding = SLIDE_TIME;
  if (navigator.vibrate) navigator.vibrate(8);
}
function doLane(dir) {
  if (state !== 'playing') return;
  const nl = clamp(P.lane + dir, 0, 2);
  if (nl !== P.lane) { P.lane = nl; AudioSys.lane(); }
}

function animatePlayer(dt) {
  P.runT += dt * (6 + speed * 0.45);
  const sw = Math.sin(P.runT);
  if (state === 'dying') {
    P.tumble += dt * 7;
    player.rotation.x = -P.tumble;
    player.position.y = P.y + Math.sin(Math.min(P.tumble, 3)) * 0.6;
  } else if (!P.grounded) {
    // jump pose: legs tucked, arms up
    charParts.legL.rotation.x = -0.9; charParts.legR.rotation.x = 0.5;
    charParts.armL.rotation.x = -2.4; charParts.armR.rotation.x = -2.4;
    player.rotation.x = 0.08;
  } else if (P.sliding > 0) {
    charParts.legL.rotation.x = -1.1; charParts.legR.rotation.x = -1.1;
    charParts.armL.rotation.x = 0.6; charParts.armR.rotation.x = 0.6;
    player.rotation.x = -0.85;
    player.position.y = Math.max(0, P.y - 0.25);
  } else {
    charParts.legL.rotation.x = sw * 0.85;
    charParts.legR.rotation.x = -sw * 0.85;
    charParts.armL.rotation.x = -sw * 0.75;
    charParts.armR.rotation.x = sw * 0.75;
    player.rotation.x = 0.12;
    player.position.y = P.y + Math.abs(Math.cos(P.runT)) * 0.07;
  }
  player.position.x += (LANES[P.lane] - player.position.x) * Math.min(1, dt * 12);
  player.rotation.y = (LANES[P.lane] - player.position.x) * -0.25;
  P.x = player.position.x;
  blob.position.set(P.x, 0.02, player.position.z);
  const bs = 1 - clamp(P.y / 3, 0, 0.5);
  blob.scale.set(bs, bs, 1);
  blob.material.opacity = 0.35 * bs;
  shieldBubble.visible = shieldT > 0 && state === 'playing';
  shieldBubble.position.set(P.x, P.y + 1.1, player.position.z);
}

// ---------------- Obstacles ----------------
const obstacles = [];
function makeObstacleMesh(kind) {
  const g = new THREE.Group();
  if (kind === 'low') {
    // fallen stone block to JUMP
    const b = new THREE.Mesh(G.box, M.obstacleStone);
    b.scale.set(1.9, 1.0, 0.7); b.position.y = 0.5;
    g.add(b);
    const moss = new THREE.Mesh(G.box, M.moss);
    moss.scale.set(1.95, 0.18, 0.75); moss.position.y = 1.05;
    g.add(moss);
    g.userData = { w: 1.9, hBot: 0, hTop: 1.0, d: 0.7, pass: 'jump', label: 'stone block' };
  } else if (kind === 'fire') {
    // fire trap full-width-ish to JUMP (per-lane piece)
    const base = new THREE.Mesh(G.box, M.woodDark);
    base.scale.set(1.9, 0.25, 1.2); base.position.y = 0.12;
    g.add(base);
    for (let i = -1; i <= 1; i++) {
      const f = new THREE.Mesh(G.flame, i === 0 ? M.flameCore : M.flame);
      f.position.set(i * 0.55, 0.55, 0); f.scale.set(1.4, 1.6, 1.4);
      f.userData.flicker = i * 2;
      g.add(f);
    }
    const glow = new THREE.Mesh(new THREE.PlaneGeometry(1.9, 1.2), M.lava);
    glow.rotation.x = -Math.PI / 2; glow.position.y = 0.26;
    g.add(glow);
    g.userData = { w: 1.9, hBot: 0, hTop: 0.85, d: 1.2, pass: 'jump', label: 'fire trap', flames: true };
  } else if (kind === 'top') {
    // wooden overhang to SLIDE under
    for (const s of [-1, 1]) {
      const post = new THREE.Mesh(G.box, M.wood);
      post.scale.set(0.25, 2.2, 0.25); post.position.set(s * 1.0, 1.1, 0);
      g.add(post);
    }
    const plank = new THREE.Mesh(G.box, M.woodDark);
    plank.scale.set(2.3, 0.5, 0.8); plank.position.y = 1.7;
    g.add(plank);
    const skull = new THREE.Mesh(G.box, M.pillarTop);
    skull.scale.set(0.5, 0.5, 0.5); skull.position.y = 1.35;
    g.add(skull);
    g.userData = { w: 2.0, hBot: 1.05, hTop: 2.0, d: 0.8, pass: 'slide', label: 'low beam' };
  } else if (kind === 'blade') {
    // spinning blade pole to SLIDE under
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 2.4, 8), M.bladePole);
    pole.position.y = 1.2;
    g.add(pole);
    const spin = new THREE.Group();
    const b1 = new THREE.Mesh(G.blade, M.blade);
    spin.add(b1);
    const b2 = new THREE.Mesh(G.blade, M.blade);
    b2.rotation.y = Math.PI / 2;
    spin.add(b2);
    spin.position.y = 1.35;
    g.add(spin);
    g.userData.spin = spin;
    g.userData = { ...g.userData, w: 2.0, hBot: 1.0, hTop: 1.7, d: 0.8, pass: 'slide', label: 'spinning blades' };
  } else {
    // tall wall — must NOT be in this lane
    const w = new THREE.Mesh(G.box, M.wall);
    w.scale.set(2.1, 3.0, 0.8); w.position.y = 1.5;
    g.add(w);
    const cap = new THREE.Mesh(G.box, M.moss);
    cap.scale.set(2.2, 0.25, 0.9); cap.position.y = 3.05;
    g.add(cap);
    const crack = new THREE.Mesh(G.box, M.woodDark);
    crack.scale.set(0.25, 2.4, 0.85); crack.position.set(0.4, 1.4, 0);
    g.add(crack);
    g.userData = { w: 2.1, hBot: 0, hTop: 3.0, d: 0.8, pass: 'dodge', label: 'temple wall' };
  }
  g.visible = false;
  scene.add(g);
  return g;
}
const OB_KINDS = ['low', 'fire', 'top', 'blade', 'wall'];
for (let i = 0; i < 40; i++) {
  const kind = OB_KINDS[i % OB_KINDS.length];
  obstacles.push({ mesh: makeObstacleMesh(kind), kind, active: false, z: 0, lane: 1 });
}
function spawnObstacle(kind, lane, z) {
  let o = obstacles.find((o) => !o.active && o.kind === kind);
  if (!o) o = obstacles.find((o) => !o.active);
  if (!o) return;
  // rebuild mesh if kind differs
  if (o.kind !== kind) {
    scene.remove(o.mesh);
    o.mesh = makeObstacleMesh(kind);
    o.kind = kind;
  }
  o.active = true; o.lane = lane; o.z = z;
  o.mesh.visible = true;
  o.mesh.position.set(LANES[lane], 0, z);
}
function clearObstacles() {
  for (const o of obstacles) { o.active = false; o.mesh.visible = false; }
}

// ---------------- Coins & powerups ----------------
const coins = [];
for (let i = 0; i < 90; i++) {
  const m = new THREE.Mesh(G.coin, M.gold);
  m.visible = false;
  scene.add(m);
  coins.push({ mesh: m, active: false, x: 0, y: 1, z: 0, magnet: false });
}
function spawnCoin(x, y, z) {
  const c = coins.find((c) => !c.active);
  if (!c) return;
  c.active = true; c.x = x; c.y = y; c.z = z; c.magnet = false;
  c.mesh.visible = true;
  c.mesh.position.set(x, y, z);
}
function clearCoins() { for (const c of coins) { c.active = false; c.mesh.visible = false; } }

const POWER_DEFS = {
  magnet: { mat: 'magnet', label: '🧲 MAGNET', text: '🧲' },
  shield: { mat: 'shield', label: '🛡️ SHIELD', text: '🛡' },
  boost: { mat: 'boost', label: '⚡ 2X SCORE', text: '⚡' },
};
const powerups = [];
for (let i = 0; i < 4; i++) {
  const grp = new THREE.Group();
  const orb = new THREE.Mesh(new THREE.SphereGeometry(0.45, 14, 12),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9 }));
  grp.add(orb);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.65, 0.08, 8, 20),
    new THREE.MeshBasicMaterial({ color: 0xffffff }));
  grp.add(ring);
  grp.visible = false;
  grp.userData.ring = ring;
  scene.add(grp);
  powerups.push({ mesh: grp, orb, active: false, kind: 'magnet', z: 0, lane: 1 });
}
function spawnPowerup(kind, lane, z) {
  const p = powerups.find((p) => !p.active);
  if (!p) return;
  p.active = true; p.kind = kind; p.lane = lane; p.z = z;
  const color = { magnet: 0xff5d5d, shield: 0x54e0ff, boost: 0x9d7bff }[kind];
  p.orb.material.color.set(color);
  p.mesh.userData.ring.material.color.set(color);
  p.mesh.visible = true;
  p.mesh.position.set(LANES[lane], 1.2, z);
}
function clearPowerups() { for (const p of powerups) { p.active = false; p.mesh.visible = false; } }

// ---------------- Spawning patterns ----------------
function coinLine(lane, z0, n, y = 1) {
  for (let i = 0; i < n; i++) spawnCoin(LANES[lane], y, z0 + i * 2);
}
function coinArc(lane, z0) {
  const ys = [1, 1.6, 2.1, 1.6, 1];
  for (let i = 0; i < 5; i++) spawnCoin(LANES[lane], ys[i], z0 - 4 + i * 2);
}
function coinZigzag(z0) {
  const seq = [0, 1, 2, 1, 0, 1, 2];
  seq.forEach((l, i) => spawnCoin(LANES[l], 1, z0 + i * 2.2));
}
function shuffledLanes() {
  const a = [0, 1, 2];
  for (let i = 2; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1));[a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
function spawnRow(z) {
  const r = Math.random();
  const lanes = shuffledLanes();
  if (r < 0.20) {
    // LOW barriers: 1-2 lanes, coins arc over first
    const n = Math.random() < 0.5 ? 1 : 2;
    for (let i = 0; i < n; i++) spawnObstacle('low', lanes[i], z);
    coinArc(lanes[0], z);
  } else if (r < 0.36) {
    // OVERHANG beams: 1-2 lanes, coin line under (reward slide)
    const n = Math.random() < 0.5 ? 1 : 2;
    for (let i = 0; i < n; i++) {
      spawnObstacle('top', lanes[i], z);
      coinLine(lanes[i], z - 3, 4, 0.6);
    }
  } else if (r < 0.52) {
    // WALLS in 2 lanes, free lane has coins
    spawnObstacle('wall', lanes[0], z);
    spawnObstacle('wall', lanes[1], z);
    coinLine(lanes[2], z - 3, 5, 1);
  } else if (r < 0.66) {
    // FULL-WIDTH fire: must jump (fair in any lane)
    for (let l = 0; l < 3; l++) spawnObstacle('fire', l, z);
    coinArc(1, z);
    coinLine(0, z - 6, 3, 1); coinLine(2, z - 6, 3, 1);
  } else if (r < 0.78) {
    // FULL-WIDTH blades: must slide
    for (let l = 0; l < 3; l++) spawnObstacle('blade', l, z);
    coinLine(1, z - 4, 5, 0.6);
  } else if (r < 0.88) {
    // Slalom walls: two rows, different free lanes
    spawnObstacle('wall', lanes[0], z);
    spawnObstacle('wall', lanes[1], z);
    const free2 = (lanes[2] + randInt(1, 2)) % 3;
    const z2 = z + 16;
    for (let l = 0; l < 3; l++) if (l !== free2) spawnObstacle('wall', l, z2);
    coinLine(lanes[2], z - 2, 3, 1);
    coinLine(free2, z2 - 2, 3, 1);
    nextSpawnZ = Math.max(nextSpawnZ, 0); // spacing handled by caller gap
  } else {
    // Breather: coins only
    if (Math.random() < 0.5) coinZigzag(z);
    else { coinLine(lanes[0], z, 6, 1); coinArc(lanes[1], z + 12); }
  }
}

// ---------------- Dust particles ----------------
const DUST_N = 40;
const dustGeo = new THREE.BufferGeometry();
const dustPos = new Float32Array(DUST_N * 3);
dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPos, 3));
const dust = new THREE.Points(dustGeo, new THREE.PointsMaterial({ color: 0xd8c49a, size: 0.25, transparent: true, opacity: 0.7 }));
scene.add(dust);
const dustVel = [];
for (let i = 0; i < DUST_N; i++) dustVel.push({ life: Math.random() });
function updateDust(dt, pz) {
  const pos = dustGeo.attributes.position.array;
  for (let i = 0; i < DUST_N; i++) {
    const d = dustVel[i];
    d.life -= dt * 1.5;
    if (d.life <= 0) {
      d.life = rand(0.4, 1);
      pos[i * 3] = P.x + rand(-0.4, 0.4);
      pos[i * 3 + 1] = rand(0.05, 0.4);
      pos[i * 3 + 2] = pz + rand(-0.5, 0.5);
    } else {
      pos[i * 3 + 1] += dt * 1.2;
      pos[i * 3 + 2] += dt * (2 + speed * 0.2);
    }
  }
  dustGeo.attributes.position.needsUpdate = true;
  dust.visible = state === 'playing' && P.grounded;
}

// ---------------- Input ----------------
// Swipe
let touchStart = null;
const SWIPE_MIN = 24;
canvas.addEventListener('touchstart', (e) => {
  e.preventDefault();
  AudioSys.init();
  const t = e.changedTouches[0];
  touchStart = { x: t.clientX, y: t.clientY, t: Date.now() };
}, { passive: false });
canvas.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
canvas.addEventListener('touchend', (e) => {
  e.preventDefault();
  if (!touchStart) return;
  const t = e.changedTouches[0];
  const dx = t.clientX - touchStart.x, dy = t.clientY - touchStart.y;
  const adx = Math.abs(dx), ady = Math.abs(dy);
  if (Math.max(adx, ady) < SWIPE_MIN) { touchStart = null; return; } // ignore taps on canvas
  if (adx > ady) doLane(dx > 0 ? 1 : -1);
  else if (dy < 0) doJump();
  else doSlide();
  touchStart = null;
}, { passive: false });
// Mouse swipe (for desktop testing)
let mouseDown = null;
canvas.addEventListener('mousedown', (e) => { mouseDown = { x: e.clientX, y: e.clientY }; });
canvas.addEventListener('mouseup', (e) => {
  if (!mouseDown) return;
  const dx = e.clientX - mouseDown.x, dy = e.clientY - mouseDown.y;
  if (Math.max(Math.abs(dx), Math.abs(dy)) < SWIPE_MIN) { mouseDown = null; return; }
  if (Math.abs(dx) > Math.abs(dy)) doLane(dx > 0 ? 1 : -1);
  else if (dy < 0) doJump();
  else doSlide();
  mouseDown = null;
});
// Buttons
const bindBtn = (id, fn) => {
  const el = $(id);
  el.addEventListener('pointerdown', (e) => { e.preventDefault(); AudioSys.init(); fn(); });
};
bindBtn('tc-left', () => doLane(-1));
bindBtn('tc-right', () => doLane(1));
bindBtn('tc-jump', doJump);
bindBtn('tc-slide', doSlide);
// Keyboard
window.addEventListener('keydown', (e) => {
  if (e.repeat) return;
  AudioSys.init();
  const k = e.key;
  if (k === 'ArrowLeft' || k === 'a' || k === 'A') doLane(-1);
  else if (k === 'ArrowRight' || k === 'd' || k === 'D') doLane(1);
  else if (k === 'ArrowUp' || k === 'w' || k === 'W' || k === ' ') { e.preventDefault(); doJump(); }
  else if (k === 'ArrowDown' || k === 's' || k === 'S') { e.preventDefault(); doSlide(); }
  else if (k === 'p' || k === 'P' || k === 'Escape') togglePause();
  else if (k === 'Enter' && (state === 'menu' || state === 'over')) startGame();
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden && state === 'playing') togglePause(true);
});

// ---------------- UI wiring ----------------
function show(el) { el.classList.remove('hidden'); }
function hide(el) { el.classList.add('hidden'); }
function flash(color = '#fff', ms = 120) {
  const f = $('flash');
  f.style.background = color;
  f.style.opacity = '0.7';
  setTimeout(() => { f.style.opacity = '0'; }, ms);
}
$('btn-play').addEventListener('click', () => { AudioSys.init(); AudioSys.click(); startGame(); });
$('btn-again').addEventListener('click', () => { AudioSys.init(); AudioSys.click(); startGame(); });
$('btn-resume').addEventListener('click', () => { AudioSys.click(); togglePause(false); });
$('btn-restart-pause').addEventListener('click', () => { AudioSys.click(); startGame(); });
$('btn-quit-pause').addEventListener('click', () => { AudioSys.click(); toMenu(); });
$('btn-quit-over').addEventListener('click', () => { AudioSys.click(); toMenu(); });
$('btn-pause').addEventListener('click', () => togglePause());
$('btn-mute').addEventListener('click', (e) => {
  AudioSys.init();
  AudioSys.muted = !AudioSys.muted;
  e.target.textContent = AudioSys.muted ? '🔇' : '🔊';
});

function togglePause(force) {
  if (state === 'playing' && force !== false) {
    state = 'paused';
    show(pauseEl);
    AudioSys.stopDrums();
  } else if (state === 'paused' && force !== true) {
    state = 'playing';
    hide(pauseEl);
    AudioSys.startDrums();
    clock.getDelta();
  }
}
function toMenu() {
  state = 'menu';
  hide(pauseEl); hide(overEl); hide(hud);
  show(menuEl);
  $('menu-best').textContent = best;
  AudioSys.stopDrums();
  resetWorld();
}
function startGame() {
  resetWorld();
  hide(menuEl); hide(pauseEl); hide(overEl);
  show(hud);
  state = 'playing';
  AudioSys.startDrums();
  clock.getDelta();
}
function resetWorld() {
  distance = 0; coinCount = 0; score = 0; speed = BASE_SPEED;
  magnetT = 0; shieldT = 0; boostT = 0;
  P.lane = 1; P.x = 0; P.y = 0; P.vy = 0; P.sliding = 0; P.grounded = true; P.tumble = 0;
  player.position.set(0, 0, 0);
  player.rotation.set(0.12, 0, 0);
  nextSpawnZ = 34; nextPowerZ = 180;
  shake = 0;
  // restore track segments to start layout (they recycle during runs)
  for (const g of segments) g.position.z = -g.userData.index * SEG_LEN + 20;
  clearObstacles(); clearCoins(); clearPowerups();
  coinEl.textContent = '0'; scoreEl.textContent = '0';
  hudBestEl.textContent = best;
  powerBar.innerHTML = '';
  $('vignette').style.opacity = '0';
  camera.position.set(0, 4.3, 7.8);
}
function gameOver(cause) {
  if (state !== 'playing') return;
  state = 'dying';
  deathCause = cause;
  deathTimer = 1.25;
  shake = 1;
  $('vignette').style.opacity = '1';
  AudioSys.crash();
  AudioSys.stopDrums();
  if (navigator.vibrate) navigator.vibrate([60, 40, 80]);
}
function finishGameOver() {
  state = 'over';
  const finalScore = score;
  const isBest = finalScore > best;
  if (isBest) { best = finalScore; localStorage.setItem(BEST_KEY, String(best)); }
  $('final-score').textContent = finalScore;
  $('final-coins').textContent = coinCount;
  $('final-dist').textContent = Math.floor(distance) + 'm';
  $('death-cause').textContent = deathCause;
  $('menu-best').textContent = best;
  $('new-best').classList.toggle('hidden', !isBest);
  hide(hud);
  show(overEl);
}

// ---------------- Collision ----------------
function checkCollisions(pz) {
  const pB = playerBottom(), pT = playerTop();
  for (const o of obstacles) {
    if (!o.active) continue;
    const dz = o.z - pz;
    const half = (o.mesh.userData.d || 0.8) / 2 + 0.35;
    if (Math.abs(dz) > half) continue;
    const ox = LANES[o.lane];
    if (Math.abs(P.x - ox) > (o.mesh.userData.w / 2 + 0.28)) continue;
    // vertical overlap?
    if (pB < o.mesh.userData.hTop - 0.08 && pT > o.mesh.userData.hBot + 0.08) {
      if (shieldT > 0) {
        shieldT = 0;
        o.active = false; o.mesh.visible = false;
        flash('#54e0ff', 200);
        AudioSys.power();
        continue;
      }
      const kindName = { low: 'Tripped on a fallen block', fire: 'Burned by a fire trap', top: 'Slammed into a low beam', blade: 'Shredded by spinning blades', wall: 'Smashed into a temple wall' }[o.kind] || 'Crashed';
      gameOver(kindName + ' — ' + Math.floor(distance) + 'm');
      return;
    }
  }
  // coins
  for (const c of coins) {
    if (!c.active) continue;
    const dz = c.z - pz;
    if (Math.abs(dz) > (c.magnet ? 7 : 1.1)) continue;
    const dx = c.x - P.x, dy = c.y - (P.y + 1);
    if (c.magnet || (Math.abs(dx) < 1.0 && Math.abs(dy) < 1.2)) {
      if (c.magnet) {
        c.x += (P.x - c.x) * 0.35;
        c.y += ((P.y + 1) - c.y) * 0.35;
        c.z += (pz - c.z) * 0.35;
        c.mesh.position.set(c.x, c.y, c.z);
        if (Math.abs(c.z - pz) > 1.1) continue;
      }
      c.active = false; c.mesh.visible = false;
      coinCount++;
      coinEl.textContent = coinCount;
      AudioSys.coin();
    }
  }
  // powerups
  for (const p of powerups) {
    if (!p.active) continue;
    if (Math.abs(p.z - pz) > 1.1) continue;
    if (Math.abs(LANES[p.lane] - P.x) > 1.1) continue;
    if (Math.abs(1.2 - (P.y + 1)) > 1.6) continue;
    p.active = false; p.mesh.visible = false;
    AudioSys.power();
    flash('#ffffff', 150);
    if (p.kind === 'magnet') magnetT = 8;
    else if (p.kind === 'shield') shieldT = 20;
    else boostT = 8;
  }
}

// ---------------- HUD power pills ----------------
function updatePowerBar() {
  let html = '';
  if (magnetT > 0) html += `<span class="power-pill">🧲 ${Math.ceil(magnetT)}s</span>`;
  if (shieldT > 0) html += `<span class="power-pill">🛡️ SHIELD</span>`;
  if (boostT > 0) html += `<span class="power-pill">⚡ 2X ${Math.ceil(boostT)}s</span>`;
  if (powerBar._html !== html) { powerBar.innerHTML = html; powerBar._html = html; }
}

// ---------------- Main loop ----------------
const clock = new THREE.Clock();
let camX = 0;

function update(dt, t) {
  // ambient animation always runs (menu background)
  flickerFlames(t);
  for (const c of clouds) {
    c.position.z = ((c.userData.z + t * 0.6) % 260) - 60 + camera.position.z - 60;
  }

  if (state === 'playing' || state === 'dying') {
    if (state === 'playing') {
      speed = Math.min(BASE_SPEED + distance * 0.014, MAX_SPEED);
      const dz = speed * dt;
      distance += dz;
      score = Math.floor(distance + coinCount * 10 * (boostT > 0 ? 2 : 1));
      player.position.z += dz;
      const pz = player.position.z;

      // physics
      if (!P.grounded || P.y > 0) {
        P.vy += GRAVITY * dt;
        P.y += P.vy * dt;
        if (P.y <= 0) { P.y = 0; P.vy = 0; P.grounded = true; }
      }
      if (P.sliding > 0) P.sliding -= dt;
      if (magnetT > 0) { magnetT -= dt; for (const c of coins) if (c.active && Math.abs(c.z - pz) < 7) c.magnet = true; }
      if (shieldT > 0) shieldT -= dt;
      if (boostT > 0) boostT -= dt;

      // spawn ahead
      const diff = clamp(distance / 1600, 0, 1);
      while (nextSpawnZ < pz + SPAWN_AHEAD) {
        spawnRow(nextSpawnZ);
        nextSpawnZ += rand(20, 30) - diff * 7;
      }
      if (nextPowerZ < pz + SPAWN_AHEAD) {
        spawnPowerup(pick(['magnet', 'shield', 'boost']), randInt(0, 2), nextPowerZ);
        nextPowerZ += rand(220, 340);
      }
      recycleSegments(pz);
      checkCollisions(pz);
      updateDust(dt, pz);

      // HUD
      scoreEl.textContent = score;
      if (score > best) hudBestEl.textContent = score;
      updatePowerBar();
    } else {
      // dying: decelerate world scroll feel, keep tumbling
      deathTimer -= dt;
      player.position.z += speed * dt * Math.max(0, deathTimer);
      if (deathTimer <= 0) finishGameOver();
    }

    const pz = player.position.z;
    animatePlayer(state === 'playing' ? dt : dt * 0.6);

    // spin coins / blades / powerups
    for (const c of coins) {
      if (!c.active || c.z < pz - 10) { if (c.active && c.z < pz - 10) { c.active = false; c.mesh.visible = false; } continue; }
      c.mesh.rotation.y += dt * 4;
    }
    for (const o of obstacles) {
      if (!o.active) continue;
      if (o.z < pz - 15) { o.active = false; o.mesh.visible = false; continue; }
      if (o.mesh.userData.spin) o.mesh.userData.spin.rotation.y += dt * 6;
      if (o.kind === 'fire') {
        o.mesh.children.forEach((f, i) => {
          if (f.geometry === G.flame) f.scale.y = 1.6 + Math.sin(t * 15 + f.userData.flicker + o.z) * 0.35;
        });
      }
    }
    for (const p of powerups) {
      if (!p.active) continue;
      if (p.z < pz - 12) { p.active = false; p.mesh.visible = false; continue; }
      p.mesh.rotation.y += dt * 2.5;
      p.mesh.position.y = 1.2 + Math.sin(t * 3 + p.z) * 0.15;
    }

    // camera follow
    shake = Math.max(0, shake - dt * 1.4);
    camX += (P.x * 0.55 - camX) * Math.min(1, dt * 6);
    const shx = shake > 0 ? rand(-1, 1) * shake * 0.5 : 0;
    const shy = shake > 0 ? rand(-1, 1) * shake * 0.4 : 0;
    camera.position.set(camX + shx, 4.3 + P.y * 0.22 + shy, pz + 7.8);
    camera.lookAt(P.x * 0.72, 1.6 + P.y * 0.3, pz - 8);
    camera.fov += (((boostT > 0 && state === 'playing') ? 70 : 62) - camera.fov) * Math.min(1, dt * 3);
    camera.updateProjectionMatrix();
  } else {
    // menu idle: slow cinematic drift
    const pz = player.position.z;
    animatePlayer(dt);
    for (const c of coins) if (c.active) c.mesh.rotation.y += dt * 4;
    camera.position.set(Math.sin(t * 0.2) * 3, 4.6, pz + 8.5);
    camera.lookAt(0, 1.4, pz - 10);
  }
}

function loop() {
  requestAnimationFrame(loop);
  const dt = Math.min(clock.getDelta(), 0.05);
  const t = clock.elapsedTime;
  update(dt, t);
  charLight.position.set(player.position.x + 2.5, 6, player.position.z + 9);
  renderer.render(scene, camera);
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('dblclick', (e) => e.preventDefault(), { passive: false });

// Pre-spawn some coins for the menu backdrop
coinLine(1, 8, 5, 1);
resetWorld();

// Read-only hook for automated playtesting (used by soak-test bots)
window.__td = {
  get state() { return state; },
  get lane() { return P.lane; },
  get z() { return player.position.z; },
  get score() { return score; },
  get coins() { return coinCount; },
  get distance() { return distance; },
  obstacles() { return obstacles.filter((o) => o.active).map((o) => ({ kind: o.kind, lane: o.lane, z: o.z })); },
};
loop();
