// Mare Postmarkii — a walkable lunar surface.
//
// The physics are the real ones, and two of them are load-bearing:
//   g = 1.62 m/s², so a jump clears about three metres and hangs for four seconds;
//   walking is limited by the pendulum a leg makes, v ~ sqrt(gL), so at a sixth of
//   a gravity you walk at 0.6 m/s — slower than on Earth, not faster. Bounding is
//   how you actually travel, which is what Apollo crews worked out for themselves.
//
// There is no air, so there is no scattering: the sun is a hard white key light,
// the shadows are nearly black, and the sky stays black with the sun up.

import * as THREE from 'three';
import { installActions } from './world.js';

export const C = {
  FIELD: 320,            // metres across — a nod to the town's 320 km extent
  G: 1.62,               // m/s², the Moon's own
  EYE: 1.7,              // the engine's own eye-height dial
  WALK: 0.6,             // m/s — sqrt(1/6) of an Earth walk
  BOUND_PUSH: 3.4,       // m/s of forward kick per hop
  JUMP_V: 3.12,          // sqrt(2 g h) for h = 3 m
  EARSHOT: 60,           // m, as in Postmark
  REACH: 4,              // m — how close you must be to take or enter
};

const HALF = C.FIELD / 2;

// ─────────────────────────────────────────────────────────────── noise

function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeNoise(seed) {
  const rand = mulberry(seed);
  const p = new Uint8Array(512);
  const perm = [...Array(256).keys()];
  for (let i = 255; i > 0; i--) {
    const j = (rand() * (i + 1)) | 0;
    [perm[i], perm[j]] = [perm[j], perm[i]];
  }
  for (let i = 0; i < 512; i++) p[i] = perm[i & 255];

  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  const grad = (h, x, y) => ((h & 1) ? -x : x) + ((h & 2) ? -y : y);

  const n2 = (x, y) => {
    const X = Math.floor(x) & 255, Y = Math.floor(y) & 255;
    x -= Math.floor(x); y -= Math.floor(y);
    const u = fade(x), v = fade(y);
    const A = p[X] + Y, B = p[X + 1] + Y;
    return (
      (1 - v) * ((1 - u) * grad(p[A], x, y)     + u * grad(p[B], x - 1, y)) +
      v       * ((1 - u) * grad(p[A + 1], x, y - 1) + u * grad(p[B + 1], x - 1, y - 1))
    );
  };

  const fbm = (x, y, oct = 4) => {
    let s = 0, amp = 1, f = 1, norm = 0;
    for (let i = 0; i < oct; i++) {
      s += amp * n2(x * f, y * f); norm += amp; amp *= 0.5; f *= 2.07;
    }
    return s / norm;                       // signed, roughly -1..1
  };
  return { n2, fbm };
}

// ─────────────────────────────────────────────────────── the heightfield

const noise = makeNoise(20261113);

// Craters, hand-placed so the walk has somewhere to go. r = radius,
// d = bowl depth, rim = how proud the ejecta rim stands.
export const CRATERS = [
  { name: 'the Cold Cup',      x:  -46, z:  -38, r: 44, d: 7.5, rim: 2.2 },
  { name: 'Sorting Office',    x:   62, z:   24, r: 31, d: 5.0, rim: 1.7 },
  { name: 'the Little Dish',   x:   14, z:   96, r: 19, d: 3.0, rim: 1.1 },
  { name: 'Letterfall',        x: -104, z:   72, r: 36, d: 6.0, rim: 1.9 },
  { name: 'the Quiet Basin',   x:  108, z:  -92, r: 50, d: 8.5, rim: 2.4 },
  { name: 'Threepenny',        x:  -82, z: -122, r: 16, d: 2.4, rim: 0.9 },
  { name: 'the Last Lamp',     x:  134, z:  118, r: 22, d: 3.6, rim: 1.3 },
];

export function heightAt(x, z) {
  // rolling regolith: two octaves of long swell plus fine grain
  let h = 3.2 * noise.fbm(x * 0.0042, z * 0.0042, 3)
        + 0.9 * noise.fbm(x * 0.021,  z * 0.021,  3)
        + 0.22 * noise.fbm(x * 0.14,  z * 0.14,   2);

  for (const c of CRATERS) {
    const dx = x - c.x, dz = z - c.z;
    const dist = Math.hypot(dx, dz) / c.r;
    if (dist > 2.1) continue;
    if (dist < 1) h -= c.d * (1 - dist * dist);              // the bowl
    const t = (dist - 1.02) / 0.22;
    h += c.rim * Math.exp(-0.5 * t * t);                     // the rim
  }
  return h;
}

export function normalAt(x, z, e = 0.6) {
  const hL = heightAt(x - e, z), hR = heightAt(x + e, z);
  const hD = heightAt(x, z - e), hU = heightAt(x, z + e);
  return new THREE.Vector3(hL - hR, 2 * e, hD - hU).normalize();
}

/** Which crater, if any, this point is inside. Postmark's `within`, in miniature. */
export function craterAt(x, z) {
  for (const c of CRATERS) {
    if (Math.hypot(x - c.x, z - c.z) < c.r * 0.96) return c;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────── scene

export const sim = {
  three: null,
  player: null,
  agents: [],
  marks: [],       // things left on the ground by anyone
  things: [],      // takeable objects lying about
  holding: [],     // what the resident carries
  notes: [],
  log: [],
  handle: 'vermillion',
  t: 0,
  crossing: 308,
  stamps: 7,
};

// A low sun. On the Moon the interesting light is always a low sun — it is what
// gives a surface with no air and no colour any relief at all.
const SUN_DIR = new THREE.Vector3(0.74, 0.19, -0.64).normalize();

function buildTerrain(scene) {
  const SEG = 200;
  const geo = new THREE.PlaneGeometry(C.FIELD, C.FIELD, SEG, SEG);
  geo.rotateX(-Math.PI / 2);

  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const col = new THREE.Color();

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    const h = heightAt(x, z);
    pos.setY(i, h);

    // Regolith: a mid grey that darkens in the bowls (mare basalt pooled low)
    // and brightens on the rims, where the ejecta is freshly turned over.
    const inside = CRATERS.some((c) => Math.hypot(x - c.x, z - c.z) < c.r * 0.9);
    const grain = 0.5 + 0.5 * noise.fbm(x * 0.33, z * 0.33, 2);   // fbm is signed
    let v = 0.38 + 0.16 * grain;
    if (inside) v *= 0.68;                      // mare basalt pooled in the bowls
    v += 0.09 * Math.max(0, h * 0.11);          // fresh ejecta pale on the rims
    col.setRGB(v * 1.00, v * 0.975, v * 0.93);                    // faintly warm grey
    colors[i * 3] = col.r; colors[i * 3 + 1] = col.g; colors[i * 3 + 2] = col.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();

  const tex = regolithTexture();
  tex.repeat.set(52, 52);
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, map: tex });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  scene.add(mesh);
  return mesh;
}

/**
 * The plain carries on past the walkable field. Without this the ground simply
 * stops, and the Moon's real horizon — about 2.4 km off, close enough to see the
 * curve — is the one thing you cannot fake with a backdrop.
 */
function buildFarGround(scene) {
  // 32 m spacing, chosen so grid lines land exactly on the near field's edge at
  // ±HALF — which lets the quads inside it be removed cleanly below.
  const SPAN = 5120, SEG = 160, CELL = SPAN / SEG;
  const geo = new THREE.PlaneGeometry(SPAN, SPAN, SEG, SEG);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    const r = Math.hypot(x, z);
    // the same swell as the near field, plus a slow fall-away that reads as curve
    let h = heightAt(x, z) - Math.max(0, (r - HALF)) ** 1.6 * 0.00042;
    // Tuck the inner edge down so the seam at ±HALF cannot crack open: this mesh
    // samples the ground every 32 m where the near field samples it every 1.6 m,
    // so their edges never agree exactly.
    const edge = Math.max(Math.abs(x), Math.abs(z)) - HALF;
    if (edge > -1 && edge < 200) h -= 1.2 * Math.exp(-edge / 70);
    pos.setY(i, h);
    const grain = 0.5 + 0.5 * noise.fbm(x * 0.012, z * 0.012, 3);
    const v = 0.34 + 0.12 * grain;
    colors[i * 3] = v; colors[i * 3 + 1] = v * 0.975; colors[i * 3 + 2] = v * 0.93;
  }

  // Cut a hole where the near field stands.
  //
  // Without this the two surfaces overlap, and because this one interpolates in
  // straight lines across 32 m it rides ABOVE the detailed terrain wherever the
  // ground curves away between samples — through crater bowls especially. The
  // near field is drawn too, but the far mesh still writes depth, so it clipped
  // the bottom off every billboard standing on that ground: rocks with no base,
  // and a goat with no legs.
  const idx = geo.index.array;
  const kept = [];
  const inside = (i) => Math.abs(pos.getX(i)) < HALF - 1e-3 && Math.abs(pos.getZ(i)) < HALF - 1e-3;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t], b = idx[t + 1], c = idx[t + 2];
    // drop the triangle only if it lies wholly within the near field
    if (inside(a) && inside(b) && inside(c)) continue;
    kept.push(a, b, c);
  }
  geo.setIndex(kept);
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  const tex = regolithTexture();
  tex.repeat.set(300, 300);
  const mesh = new THREE.Mesh(geo,
    new THREE.MeshLambertMaterial({ vertexColors: true, map: tex }));
  mesh.position.y = -0.06;              // sit just under the near field, hiding the seam
  scene.add(mesh);
  return mesh;
}

/**
 * Regolith. Vertex colours alone cannot carry this: at 1.6 m between vertices
 * there is nowhere to put the grain, and a flat plain under a low sun then reads
 * as one dead tone. So the fine detail goes in a tiled texture — dust, pebbles
 * and a scatter of tiny craters, which is also what gives you any sense of
 * speed while you walk.
 */
function regolithTexture() {
  const S = 512;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const c = cv.getContext('2d');
  const rand = mulberry(7731);

  c.fillStyle = '#9a968f'; c.fillRect(0, 0, S, S);

  // dust
  const img = c.getImageData(0, 0, S, S);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (rand() - 0.5) * 46;
    img.data[i] += n; img.data[i + 1] += n * 0.98; img.data[i + 2] += n * 0.94;
  }
  c.putImageData(img, 0, 0);

  // pebbles, lit from the same side as the sun
  for (let i = 0; i < 900; i++) {
    const x = rand() * S, y = rand() * S, r = 0.6 + rand() * 2.4;
    c.fillStyle = `rgba(${150 + rand() * 60 | 0},${148 + rand() * 58 | 0},${142 + rand() * 56 | 0},0.8)`;
    c.beginPath(); c.arc(x, y, r, 0, 7); c.fill();
    c.fillStyle = 'rgba(40,38,35,0.45)';
    c.beginPath(); c.arc(x - r * 0.55, y + r * 0.4, r * 0.8, 0, 7); c.fill();
  }

  // little craters — a bright rim with a dark floor, the Moon's signature at every scale
  for (let i = 0; i < 90; i++) {
    const x = rand() * S, y = rand() * S, r = 3 + rand() * 13;
    const g = c.createRadialGradient(x, y, r * 0.1, x, y, r);
    g.addColorStop(0, 'rgba(48,46,43,0.55)');
    g.addColorStop(0.72, 'rgba(96,93,88,0.30)');
    g.addColorStop(0.92, 'rgba(196,192,184,0.45)');
    g.addColorStop(1, 'rgba(150,146,139,0)');
    c.fillStyle = g; c.beginPath(); c.arc(x, y, r, 0, 7); c.fill();
  }

  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** A soft dark patch laid flat on the ground, so a billboard has feet. */
function contactShadow(x, z, size) {
  if (!contactShadow.tex) {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 64;
    const c = cv.getContext('2d');
    const g = c.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(0,0,0,0.62)');
    g.addColorStop(0.55, 'rgba(0,0,0,0.30)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = g; c.fillRect(0, 0, 64, 64);
    contactShadow.tex = new THREE.CanvasTexture(cv);
  }
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(size, size * 0.62),
    new THREE.MeshBasicMaterial({ map: contactShadow.tex, transparent: true,
                                  depthWrite: false, opacity: 0.85 }),
  );
  m.rotation.x = -Math.PI / 2;
  m.position.set(x, heightAt(x, z) + 0.05, z);
  m.renderOrder = -1;
  return m;
}

function dotTexture() {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 32;
  const g = cv.getContext('2d').createRadialGradient(16, 16, 0, 16, 16, 16);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.75)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  const c = cv.getContext('2d');
  c.fillStyle = g; c.fillRect(0, 0, 32, 32);
  return new THREE.CanvasTexture(cv);
}

function buildSky(scene) {
  // Stars. No air, so they are up there with the sun — pin-sharp and unblinking.
  const N = 2600, p = new Float32Array(N * 3), s = new Float32Array(N);
  const rand = mulberry(99);
  for (let i = 0; i < N; i++) {
    const u = rand() * 2 - 1, th = rand() * Math.PI * 2, r = Math.sqrt(1 - u * u);
    const R = 2400;
    p[i * 3] = R * r * Math.cos(th);
    p[i * 3 + 1] = R * Math.abs(u) * 0.9 + 30;
    p[i * 3 + 2] = R * r * Math.sin(th);
    s[i] = 2 + rand() * rand() * 15;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(p, 3));
  g.setAttribute('size', new THREE.BufferAttribute(s, 1));
  const stars = new THREE.Points(g, new THREE.PointsMaterial({
    map: dotTexture(), size: 9, sizeAttenuation: false,
    transparent: true, depthWrite: false, color: 0xffffff, opacity: 0.9,
  }));
  scene.add(stars);

  // Earth. About two degrees wide from here — four times the Moon we are used to —
  // and it does not rise or set, because the Moon keeps one face turned to it.
  const cv = document.createElement('canvas');
  cv.width = cv.height = 256;
  const c = cv.getContext('2d');
  c.fillStyle = '#17458c'; c.fillRect(0, 0, 256, 256);
  const blob = (x, y, w, h, col) => {
    c.fillStyle = col; c.beginPath(); c.ellipse(x, y, w, h, 0, 0, 7); c.fill();
  };
  blob(70, 120, 34, 46, '#3f6b3a'); blob(104, 96, 20, 22, '#4a7340');
  blob(170, 150, 40, 34, '#3a6038'); blob(198, 86, 24, 20, '#50743f');
  blob(40, 52, 30, 16, '#dfe7ee');  blob(150, 42, 44, 14, '#e6ecf2');
  blob(96, 196, 54, 18, '#dfe7ee'); blob(214, 196, 30, 14, '#d8e2ea');
  const tex = new THREE.CanvasTexture(cv);

  const earth = new THREE.Mesh(
    new THREE.SphereGeometry(70, 48, 32),
    new THREE.MeshLambertMaterial({ map: tex, emissive: 0x0a1328, emissiveIntensity: 1 }),
  );
  earth.position.set(-900, 620, -1500);
  scene.add(earth);

  return { stars, earth };
}

// ───────────────────────────────────────────────────── sprites and props

const loader = new THREE.TextureLoader();
const texCache = new Map();

function spriteTexture(file) {
  if (!texCache.has(file)) {
    const t = loader.load(`./sprites/${file}`);
    t.magFilter = THREE.NearestFilter;      // keep the pixels square
    t.minFilter = THREE.NearestMipmapNearestFilter;
    t.colorSpace = THREE.SRGBColorSpace;
    texCache.set(file, t);
  }
  return texCache.get(file);
}

/** A billboard standing on the ground at (x, z), `height` metres tall. */
export function makeBillboard(file, x, z, height, aspect = 1) {
  const mat = new THREE.MeshBasicMaterial({
    map: spriteTexture(file), transparent: true, alphaTest: 0.5,
    side: THREE.DoubleSide, toneMapped: false,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(height * aspect, height), mat);
  mesh.position.set(x, heightAt(x, z) + height / 2, z);
  mesh.userData.billboard = true;
  // carried along so a caller can add it; it is flat on the ground and must not
  // turn with the sprite, so it is a sibling rather than a child
  mesh.userData.shadow = contactShadow(x, z, height * aspect * 1.15);
  return mesh;
}

/** Add a billboard and its contact shadow together. */
export function addBillboard(scene, mesh) {
  scene.add(mesh);
  if (mesh.userData.shadow) scene.add(mesh.userData.shadow);
  return mesh;
}

/** Remove both again. */
export function removeBillboard(scene, mesh) {
  scene.remove(mesh);
  if (mesh.userData.shadow) scene.remove(mesh.userData.shadow);
}

export const PROPS = [
  { file: 'crater-hole.png',  h: 1.5, a: 2.36, n: 'a collapsed rille' },
  { file: 'boulder.png',      h: 3.2, a: 1.27, n: 'a boulder' },
  { file: 'cairn.png',        h: 3.6, a: 0.94, n: 'a cairn' },
  { file: 'ledge.png',        h: 2.8, a: 1.43, n: 'a shelf of rock' },
  { file: 'rubble.png',       h: 1.6, a: 1.97, n: 'broken rock' },
  { file: 'scree-big.png',    h: 2.4, a: 2.32, n: 'a scree fan' },
  { file: 'scree-small.png',  h: 1.3, a: 1.98, n: 'spilled scree' },
];

function scatterProps(scene) {
  const rand = mulberry(4242);
  const placed = [];
  for (let i = 0; i < 150; i++) {
    const x = (rand() * 2 - 1) * (HALF - 14);
    const z = (rand() * 2 - 1) * (HALF - 14);
    if (Math.hypot(x, z) < 11) continue;                  // keep the landing clear
    const p = PROPS[(rand() * PROPS.length) | 0];
    const s = 0.7 + rand() * 0.8;
    const m = makeBillboard(p.file, x, z, p.h * s, p.a);
    m.userData.label = p.n;
    addBillboard(scene, m);
    placed.push(m);
  }
  return placed;
}

// ───────────────────────────────────────────────── a wandering placeholder

/**
 * A goat, bounding about the mare. A stand-in for another agent: it occupies a
 * place, it shows up in the world reads like anything else, and you can hand it
 * something.
 *
 * The run cycle is six frames in one strip, played by sliding the texture offset
 * rather than swapping six textures — one material, one draw call. The cycle is
 * driven by DISTANCE COVERED, not by a timer, so the feet never skate: at a
 * fixed frame rate a sprite that slows down keeps running on the spot.
 */
class Wanderer {
  constructor(scene, opts = {}) {
    this.id = opts.id || 'the-moon/a-goat';
    this.name = opts.name || 'a brown goat';
    this.frames = 6;
    this.stride = 2.6;             // metres covered by one full six-frame cycle
    this.speed = 3.1;              // m/s over the ground while running
    this.hop = 1.7;                // m/s of push-off — it bounds, like everything here
    this.state = 'resting';
    this.rest = 1.2;
    this.look = null;              // set when something speaks nearby

    const tex = spriteTexture('goat-run.png');
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(1 / this.frames, 1);
    this.tex = tex;

    const h = opts.height || 1.5;
    this.h = h;
    this.mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(h * 1.469, h),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, alphaTest: 0.5,
                                    side: THREE.DoubleSide, toneMapped: false }),
    );
    this.pos = new THREE.Vector3(opts.x ?? 40, 0, opts.z ?? 40);
    this.pos.y = heightAt(this.pos.x, this.pos.z);
    this.vel = new THREE.Vector3();
    this.grounded = true;
    this.travelled = 0;
    this.heading = new THREE.Vector3(1, 0, 0);
    this.target = null;

    this.shadow = contactShadow(this.pos.x, this.pos.z, h * 1.3);
    scene.add(this.mesh);
    scene.add(this.shadow);
  }

  get x() { return this.pos.x; }
  get z() { return this.pos.z; }

  pickTarget(rand = Math.random) {
    const a = rand() * Math.PI * 2;
    const r = 25 + rand() * 90;
    this.target = new THREE.Vector3(
      THREE.MathUtils.clamp(this.pos.x + Math.cos(a) * r, -HALF + 12, HALF - 12), 0,
      THREE.MathUtils.clamp(this.pos.z + Math.sin(a) * r, -HALF + 12, HALF - 12),
    );
    this.state = 'running';
  }

  update(dt) {
    if (this.state === 'resting') {
      this.rest -= dt;
      if (this.rest <= 0) this.pickTarget();
    }

    if (this.state === 'running' && this.target) {
      const dx = this.target.x - this.pos.x, dz = this.target.z - this.pos.z;
      const d = Math.hypot(dx, dz);
      if (d < 2) {
        this.state = 'resting';
        this.rest = 1 + Math.random() * 4;
        this.vel.x = this.vel.z = 0;
      } else {
        this.heading.set(dx / d, 0, dz / d);
        if (this.grounded) {
          // a bound, not a trot: push off and go ballistic, the way everything
          // with legs ends up moving at a sixth of a gravity
          this.vel.set(this.heading.x * this.speed, this.hop, this.heading.z * this.speed);
          this.grounded = false;
        }
      }
    }

    if (!this.grounded) this.vel.y -= C.G * dt;

    const px = this.pos.x, pz = this.pos.z;
    this.pos.addScaledVector(this.vel, dt);
    this.pos.x = THREE.MathUtils.clamp(this.pos.x, -HALF + 6, HALF - 6);
    this.pos.z = THREE.MathUtils.clamp(this.pos.z, -HALF + 6, HALF - 6);
    this.travelled += Math.hypot(this.pos.x - px, this.pos.z - pz);

    const floor = heightAt(this.pos.x, this.pos.z);
    if (this.pos.y <= floor) {
      this.pos.y = floor;
      this.vel.y = 0;
      this.grounded = true;
      if (this.state !== 'running') { this.vel.x = this.vel.z = 0; }
    }

    // frame by distance, so the gait matches the ground speed
    const f = this.state === 'resting' && this.grounded
      ? 0
      : Math.floor(this.travelled / this.stride * this.frames) % this.frames;
    this.tex.offset.x = f / this.frames;
    this.frame = f;

    this.mesh.position.set(this.pos.x, this.pos.y + this.h / 2, this.pos.z);
    this.shadow.position.set(this.pos.x, floor + 0.05, this.pos.z);
    // the shadow shrinks and fades as it rises — the only cue that it is airborne
    const air = Math.max(0, this.pos.y - floor);
    const k = 1 / (1 + air * 0.5);
    this.shadow.scale.setScalar(0.55 + 0.45 * k);
    this.shadow.material.opacity = 0.85 * k;
  }

  /** Billboard on Y, and mirror so the goat faces the way it is going. */
  face(camera) {
    const m = this.mesh;
    const nx = camera.position.x - m.position.x, nz = camera.position.z - m.position.z;
    const len = Math.hypot(nx, nz) || 1;
    m.rotation.set(0, Math.atan2(nx, nz), 0);
    // the plane's local +X in world, once it is turned to face the camera
    const rx = nz / len, rz = -nx / len;
    const facingScreenRight = (this.heading.x * rx + this.heading.z * rz) > 0;
    m.scale.x = facingScreenRight ? 1 : -1;
  }
}

// ─────────────────────────────────────────────────────────────── player

class Player {
  constructor(camera) {
    this.cam = camera;
    this.pos = new THREE.Vector3(0, 0, 0);
    this.vel = new THREE.Vector3();
    this.yaw = 0; this.pitch = 0;
    this.grounded = true;
    this.pos.y = heightAt(0, 0) + C.EYE;
    this.autoWalk = null;              // set by the `walk` action
  }

  get ground() { return heightAt(this.pos.x, this.pos.z); }

  jump() {
    if (!this.grounded) return false;
    this.vel.y = C.JUMP_V;
    this.grounded = false;
    return true;
  }

  update(dt, input) {
    // horizontal intent
    let fx = 0, fz = 0;
    let closing = false;        // on the last few metres, stop bounding
    if (this.autoWalk) {
      const dx = this.autoWalk.x - this.pos.x, dz = this.autoWalk.z - this.pos.z;
      const d = Math.hypot(dx, dz);
      if (d < 0.8 && this.grounded) { this.autoWalk = null; this.vel.x = this.vel.z = 0; }
      else {
        fx = dx / d; fz = dz / d; this.yaw = Math.atan2(-fx, -fz);
        // A bound is ballistic, so the last hop sails straight past the target.
        // Walk the final approach, which is what you would actually do.
        closing = d < 7;
      }
    } else if (input) {
      const f = (input.fwd ? 1 : 0) - (input.back ? 1 : 0);
      const s = (input.right ? 1 : 0) - (input.left ? 1 : 0);
      if (f || s) {
        const len = Math.hypot(f, s);
        const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
        fx = (-sy * f + cy * s) / len;
        fz = (-cy * f - sy * s) / len;
      }
    }

    const bounding = !closing &&
      ((input && input.bound) || !!(this.autoWalk && this.autoWalk.bound));
    if (this.grounded) {
      if (bounding && (fx || fz)) {
        // A bound is a hop, not a run: push off, go ballistic, land, push again.
        this.vel.set(fx * C.BOUND_PUSH, C.JUMP_V * 0.62, fz * C.BOUND_PUSH);
        this.grounded = false;
      } else {
        this.vel.x = fx * C.WALK;
        this.vel.z = fz * C.WALK;
      }
    } else {
      // In flight you keep your momentum — there is no air to slow you and no
      // traction to steer with. This is most of what low gravity feels like.
      this.vel.y -= C.G * dt;
    }

    const px = this.pos.x, pz = this.pos.z;
    this.pos.addScaledVector(this.vel, dt);
    // measured, not intended: the velocity is zeroed on landing each frame, so
    // reading it back would report a standing start every step.
    this.speed = Math.hypot(this.pos.x - px, this.pos.z - pz) / Math.max(dt, 1e-6);
    this.pos.x = THREE.MathUtils.clamp(this.pos.x, -HALF + 2, HALF - 2);
    this.pos.z = THREE.MathUtils.clamp(this.pos.z, -HALF + 2, HALF - 2);

    const floor = this.ground + C.EYE;
    if (this.pos.y <= floor) {
      this.pos.y = floor;
      if (!this.grounded) { this.vel.y = 0; this.grounded = true; }
      if (!bounding) { this.vel.x = 0; this.vel.z = 0; }
    } else {
      this.grounded = false;
    }

    this.cam.position.copy(this.pos);
    this.cam.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
  }
}

// ─────────────────────────────────────────────────────────────── boot

function boot() {
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  document.body.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000006);

  const camera = new THREE.PerspectiveCamera(72, innerWidth / innerHeight, 0.1, 6000);

  // No atmosphere: one hard key light, and an ambient so low it is nearly a
  // formality. On the Moon the shadows really are that black.
  const sun = new THREE.DirectionalLight(0xfff6e8, 3.0);
  sun.position.copy(SUN_DIR).multiplyScalar(500);
  scene.add(sun);
  scene.add(new THREE.AmbientLight(0x2a3346, 0.30));
  // a whisper of bounce off the regolith, so faces away from the sun are readable
  scene.add(new THREE.HemisphereLight(0x3a3630, 0x14110e, 0.35));

  const farGround = buildFarGround(scene);
  const terrain = buildTerrain(scene);
  const sky = buildSky(scene);
  const props = scatterProps(scene);
  const player = new Player(camera);

  sim.agents = [
    new Wanderer(scene, { id: 'the-moon/a-goat', name: 'a brown goat', x: 46, z: 38 }),
  ];

  sim.three = { renderer, scene, camera, terrain, sky, props, sun };
  sim.player = player;

  // ── input
  const input = { fwd: 0, back: 0, left: 0, right: 0, bound: 0 };
  const KEYS = { KeyW: 'fwd', ArrowUp: 'fwd', KeyS: 'back', ArrowDown: 'back',
                 KeyA: 'left', ArrowLeft: 'left', KeyD: 'right', ArrowRight: 'right' };

  addEventListener('keydown', (e) => {
    if (KEYS[e.code]) { input[KEYS[e.code]] = 1; player.autoWalk = null; }
    if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') input.bound = 1;
    if (e.code === 'Space') { e.preventDefault(); window.moon({ do: 'jump' }); }
    if (e.code === 'KeyE') window.moon({ do: 'take' });
    if (e.code === 'KeyQ') window.moon({ do: 'drop' });
    if (e.code === 'KeyM') window.moon({ do: 'leave-mark', args: { body: 'I stood here.' } });
  });
  addEventListener('keyup', (e) => {
    if (KEYS[e.code]) input[KEYS[e.code]] = 0;
    if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') input.bound = 0;
  });

  // ── looking around
  //
  // Pointer lock is NOT available everywhere. Inside an embedded pane the
  // request is rejected with a SecurityError, and the first cut of this hid the
  // start overlay only on `pointerlockchange` — so where lock was refused the
  // overlay never went away and the page looked dead. The overlay is dismissed
  // by the click itself now, and lock is treated as an upgrade: get it and the
  // mouse is free, miss it and you look around by dragging.
  const start = document.getElementById('start');
  const hint = document.getElementById('look-hint');
  let dragging = false;

  const dismiss = () => { start.style.display = 'none'; };

  // Chrome returns a promise from requestPointerLock() and rejects it when the
  // document cannot hold the lock. A bare try/catch around an await still leaves
  // the rejection unhandled in some paths, so the catch goes on the promise
  // itself — otherwise every click prints a SecurityError nobody can act on.
  const tryLock = async () => {
    try {
      const p = renderer.domElement.requestPointerLock();
      if (p && typeof p.catch === 'function') await p.catch(() => {});
    } catch { /* refused — drag-to-look is wired below */ }
  };
  addEventListener('unhandledrejection', (e) => {
    if (e.reason && e.reason.name === 'SecurityError') e.preventDefault();
  });
  document.addEventListener('pointerlockerror', (e) => e.preventDefault(), true);

  start.addEventListener('click', async () => {
    dismiss();                                   // unconditional, always first
    await tryLock();
    if (hint) {
      hint.textContent = document.pointerLockElement
        ? 'move the mouse to look · esc releases it'
        : 'drag to look — the mouse cannot be captured here';
    }
  });

  document.addEventListener('pointerlockchange', () => {
    if (hint) {
      hint.textContent = document.pointerLockElement
        ? 'move the mouse to look · esc releases it'
        : 'drag to look — the mouse cannot be captured here';
    }
  });

  const look = (dx, dy) => {
    player.yaw -= dx * 0.0022;
    player.pitch = THREE.MathUtils.clamp(player.pitch - dy * 0.0022, -1.4, 1.4);
  };

  renderer.domElement.addEventListener('mousedown', (e) => {
    if (document.pointerLockElement) return;
    dragging = true; dismiss();
    renderer.domElement.style.cursor = 'grabbing';
    e.preventDefault();
  });
  addEventListener('mouseup', () => {
    dragging = false; renderer.domElement.style.cursor = '';
  });
  addEventListener('mousemove', (e) => {
    if (document.pointerLockElement) look(e.movementX, e.movementY);
    else if (dragging) look(e.movementX, e.movementY);
  });

  // touch, for the same reason — a pane may have no mouse at all
  let lastTouch = null;
  renderer.domElement.addEventListener('touchstart', (e) => {
    dismiss(); lastTouch = e.touches[0];
  }, { passive: true });
  renderer.domElement.addEventListener('touchmove', (e) => {
    if (!lastTouch) return;
    const t = e.touches[0];
    look((t.clientX - lastTouch.clientX) * 2.2, (t.clientY - lastTouch.clientY) * 2.2);
    lastTouch = t;
  }, { passive: true });
  addEventListener('touchend', () => { lastTouch = null; });
  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });

  installActions(sim, { THREE, C, heightAt, craterAt, makeBillboard,
                        addBillboard, removeBillboard, HALF, CRATERS });

  // ── the step
  //
  // The simulation advances in fixed slices, and the slices are driven either by
  // the render loop or by an explicit moon.advance(seconds). That split matters:
  // requestAnimationFrame is throttled whenever the pane is hidden or the tab is
  // in the background, so an agent that drove the world through frames would find
  // that time simply stopped whenever nobody was looking. Postmark has the same
  // rule for the same reason — position is arithmetic over the record and the
  // instant, never something a frame happened to integrate.
  const STEP = 1 / 60;

  sim.step = (dt) => {
    sim.t += dt;
    player.update(dt, input);
    for (const a of sim.agents) a.update(dt);
  };

  const face = (m) => {
    m.rotation.set(0, Math.atan2(camera.position.x - m.position.x,
                                 camera.position.z - m.position.z), 0);
  };

  /**
   * Turn every billboard to the camera. Called from the render loop, and also at
   * the end of advance() — otherwise a headless agent that advanced the world
   * and then looked at a sprite's orientation would read whatever the last
   * rendered frame left behind, which is stale by however long the pane was hidden.
   */
  sim.faceAll = () => {
    for (const m of props) face(m);
    for (const m of sim.marks) if (m.mesh) face(m.mesh);
    for (const t of sim.things) if (t.mesh) face(t.mesh);
    for (const a of sim.agents) a.face(camera);
  };

  /** Advance the world by `seconds` of lunar time, whatever the frame rate is. */
  sim.advance = (seconds) => {
    const n = Math.min(Math.round(seconds / STEP), 36000);   // cap: 10 minutes
    for (let i = 0; i < n; i++) sim.step(STEP);
    sim.faceAll();
    return { advanced_s: +(n * STEP).toFixed(2) };
  };

  const clock = new THREE.Clock();
  let acc = 0, carry = 0;
  renderer.setAnimationLoop(() => {
    // fixed-step accumulator, so the physics do not vary with the frame rate
    carry += Math.min(clock.getDelta(), 0.25);
    let guard = 0;
    while (carry >= STEP && guard++ < 20) { sim.step(STEP); carry -= STEP; }

    // Billboards turn on Y only. Copying the camera's whole quaternion tips them
    // with the pitch, which lifts their feet off the ground when you look down.
    sim.faceAll();
    sun.position.copy(player.pos).addScaledVector(SUN_DIR, 500);
    sun.target.position.copy(player.pos);
    sun.target.updateMatrixWorld();

    acc += STEP;
    if (acc > 0.2) { acc = 0; window.moon.hud(); }
    renderer.render(scene, camera);
  });
}

boot();
