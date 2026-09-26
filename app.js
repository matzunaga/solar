(() => {
  "use strict";

  const FEEDS = {
    wind: "https://services.swpc.noaa.gov/json/rtsw/rtsw_wind_1m.json",
    mag: "https://services.swpc.noaa.gov/json/rtsw/rtsw_mag_1m.json",
    kp: "https://services.swpc.noaa.gov/json/planetary_k_index_1m.json",
    flare: "https://services.swpc.noaa.gov/json/goes/primary/xray-flares-latest.json"
  };

  const REFRESH_MS = 5 * 60 * 1000;
  const L1_KM = 1.5e6;
  const SPIN_SECONDS = 150; // one turn of the Earth, far faster than life
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const TAU = Math.PI * 2;

  const canvas = document.getElementById("sky");
  const ctx = canvas.getContext("2d");

  const intro = document.getElementById("intro");
  const reading = document.getElementById("reading");
  const startButton = document.getElementById("start");
  const conditionEl = document.getElementById("condition");
  const arrivalEl = document.getElementById("arrival");
  const detailsEl = document.getElementById("details");
  const statusEl = document.getElementById("status");
  const soundToggle = document.getElementById("soundToggle");
  const aboutButton = document.getElementById("aboutButton");
  const aboutPanel = document.getElementById("aboutPanel");
  const closeAbout = document.getElementById("closeAbout");
  const mark = document.getElementById("mark");
  const markCard = document.getElementById("markCard");

  // Measured values, and the eased values the drawing follows
  const data = {
    speed: 420,
    density: 5,
    temperature: 1e5,
    bz: 0,
    bt: 5,
    kp: 2,
    flare: 1e-7,
    time: null,
    lastFetch: 0
  };

  const vis = { speed: 420, density: 5, temperature: 1e5, bz: 0, kp: 2, flare: 1e-7 };

  const state = {
    running: false,
    paused: false,
    started: performance.now(),
    last: performance.now(),
    clock: 0,
    width: 0,
    height: 0,
    dpr: 1,
    aurora: 0,
    soundOn: false,
    reveal: 0
  };

  const scene = {
    sun: { x: 0, y: 0, r: 0 },
    earth: { x: 0, y: 0, r: 0 },
    axis: { x: 1, y: 0 },
    normal: { x: 0, y: 1 },
    distance: 1,
    light: [-1, 0, 0],
    basis: null,
    spin0: 0
  };

  const layers = { stars: null, sun: null, corona: null, earth: null, trails: null, trailsCtx: null };
  const sprites = {};
  const particles = [];

  /* ---------- Land lattice ---------- */

  const land = (() => {
    const { count, bits } = window.LAND;
    const bytes = Uint8Array.from(atob(bits), (c) => c.charCodeAt(0));
    const golden = Math.PI * (3 - Math.sqrt(5));
    const points = [];

    for (let i = 0; i < count; i += 1) {
      if (!(bytes[i >> 3] & (1 << (i & 7)))) continue;
      const lat = Math.asin(1 - (2 * (i + 0.5)) / count);
      const lon = ((i * golden) % TAU) - Math.PI;
      points.push({ cl: Math.cos(lat), sl: Math.sin(lat), lon });
    }

    return points;
  })();

  /* ---------- Small helpers ---------- */

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const mix = (a, b, t) => a + (b - a) * t;
  const smooth = (e0, e1, x) => {
    const t = clamp((x - e0) / (e1 - e0), 0, 1);
    return t * t * (3 - 2 * t);
  };
  const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const norm3 = (v) => {
    const l = Math.hypot(v[0], v[1], v[2]);
    return [v[0] / l, v[1] / l, v[2] / l];
  };
  const cross3 = (a, b) => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0]
  ];

  function makeCanvas(w, h) {
    const c = document.createElement("canvas");
    c.width = Math.ceil(w * state.dpr);
    c.height = Math.ceil(h * state.dpr);
    const g = c.getContext("2d");
    g.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
    return [c, g];
  }

  function seeded(n) {
    const x = Math.sin(n * 12.9898) * 43758.5453;
    return x - Math.floor(x);
  }

  /* ---------- Layout ---------- */

  function resize() {
    state.dpr = Math.min(window.devicePixelRatio || 1, 2);
    state.width = window.innerWidth;
    state.height = window.innerHeight;

    canvas.width = Math.floor(state.width * state.dpr);
    canvas.height = Math.floor(state.height * state.dpr);
    canvas.style.width = `${state.width}px`;
    canvas.style.height = `${state.height}px`;
    ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);

    const w = state.width;
    const h = state.height;
    const portrait = h > w * 1.1;
    scene.portrait = portrait;

    if (portrait) {
      // the Sun hangs below the masthead so the text stays on dark sky
      const sunR = Math.min(w * 0.3, h * 0.15);
      scene.sun = { x: w * 0.5, y: Math.max(h * 0.2, 80 + sunR), r: sunR };
      // the Earth sits three quarters of the way from its old place down to the text at the bottom
      const earthR = Math.min(w * 0.17, h * 0.08);
      const textTop = intro.getBoundingClientRect().top || h * 0.8;
      const earthY = h * 0.6 + Math.max(0, textTop - (h * 0.6 + earthR)) * 0.75;
      scene.earth = { x: w * 0.5, y: earthY, r: earthR };

      // the reading starts where the intro started, so the space under the Earth holds
      reading.style.top = `${textTop}px`;
      reading.style.bottom = "auto";
    } else {
      reading.style.top = "";
      reading.style.bottom = "";
      scene.sun = { x: w * 0.05, y: h * 0.5, r: Math.min(h * 0.38, w * 0.26) };
      scene.earth = { x: w * 0.875, y: h * 0.47, r: Math.min(h * 0.15, w * 0.1) };
    }

    const dx = scene.earth.x - scene.sun.x;
    const dy = scene.earth.y - scene.sun.y;
    scene.distance = Math.hypot(dx, dy);
    scene.axis = { x: dx / scene.distance, y: dy / scene.distance };
    scene.normal = { x: -scene.axis.y, y: scene.axis.x };

    // sunlight comes from the Sun's side and a little from behind the viewer
    scene.light = norm3([-scene.axis.x, -scene.axis.y, 0.42]);

    buildBasis();
    paintStars();
    paintSun();
    paintCorona();
    paintEarth();
    makeSprites();

    [layers.trails, layers.trailsCtx] = makeCanvas(w, h);
    particles.length = 0;
    if (state.running) warmUp();
  }

  /* The Earth's axis follows the season: tipped toward the Sun in June, away in December */
  function buildBasis() {
    const now = new Date();
    const start = Date.UTC(now.getUTCFullYear(), 0, 0);
    const day = (now - start) / 86400000;
    const season = (TAU * (day - 172)) / 365.25;
    const tilt = (23.44 * Math.PI) / 180;
    const toward = Math.tan(tilt * Math.cos(season));
    const across = Math.tan(tilt * Math.sin(season));

    // screen frame: x right, y down, z toward the viewer
    // north stays up; its lean toward the Sun shows only when the Sun is off to the side
    const side = -scene.axis.x;
    const pole = norm3([toward * side, -1, -across]);

    const view = [0, 0, 1];
    const q = norm3([
      view[0] - dot3(view, pole) * pole[0],
      view[1] - dot3(view, pole) * pole[1],
      view[2] - dot3(view, pole) * pole[2]
    ]);
    const r = cross3(q, pole);
    scene.basis = { p: pole, q, r };

    // start with the Earth turned to the Sun as it is at this moment
    const hours = now.getUTCHours() + now.getUTCMinutes() / 60;
    const subsolar = (-15 * (hours - 12) * Math.PI) / 180;
    const facing = Math.atan2(dot3(scene.light, r), dot3(scene.light, q));
    scene.spin0 = facing - subsolar;
  }

  function toScreen(cl, sl, lon, spin) {
    const { p, q, r } = scene.basis;
    const a = lon + spin;
    const ca = Math.cos(a) * cl;
    const sa = Math.sin(a) * cl;
    return [
      ca * q[0] + sa * r[0] + sl * p[0],
      ca * q[1] + sa * r[1] + sl * p[1],
      ca * q[2] + sa * r[2] + sl * p[2]
    ];
  }

  /* ---------- Painted layers ---------- */

  function paintStars() {
    const w = state.width;
    const h = state.height;
    const [c, g] = makeCanvas(w, h);

    const haze = g.createRadialGradient(w * 0.5, h * 0.5, 0, w * 0.5, h * 0.5, Math.max(w, h) * 0.75);
    haze.addColorStop(0, "#080a14");
    haze.addColorStop(1, "#030308");
    g.fillStyle = haze;
    g.fillRect(0, 0, w, h);

    const count = Math.floor((w * h) / 3200);
    for (let i = 0; i < count; i += 1) {
      const x = seeded(i * 3.1) * w;
      const y = seeded(i * 7.7 + 2) * h;
      const size = Math.pow(seeded(i * 1.3 + 5), 3) * 1.3 + 0.25;
      const warmth = seeded(i * 9.1);
      const alpha = 0.15 + seeded(i * 4.9) * 0.55;
      g.fillStyle = warmth > 0.8
        ? `rgba(255, 220, 190, ${alpha})`
        : warmth < 0.25
          ? `rgba(190, 210, 255, ${alpha})`
          : `rgba(235, 235, 245, ${alpha})`;
      g.beginPath();
      g.arc(x, y, size, 0, TAU);
      g.fill();
    }

    layers.stars = c;
  }

  // a seamless tile of fractal noise for the Sun's surface, made once
  const surface = (() => {
    const size = 256;
    const c = document.createElement("canvas");
    c.width = size;
    c.height = size;
    const g = c.getContext("2d");
    const image = g.createImageData(size, size);
    const field = new Float32Array(size * size);
    let low = Infinity;
    let high = -Infinity;

    for (let octave = 0; octave < 5; octave += 1) {
      const cells = 6 * 2 ** octave; // lattice wraps at the tile edge, so the tile repeats cleanly
      const weight = 0.55 ** octave;
      const lattice = Array.from({ length: cells * cells }, (_, i) => seeded(i * 1.7 + octave * 97.3));
      const at = (x, y) => lattice[(y % cells) * cells + (x % cells)];

      for (let y = 0; y < size; y += 1) {
        const gy = (y / size) * cells;
        const y0 = Math.floor(gy);
        const ty = gy - y0;
        const sy = ty * ty * (3 - 2 * ty);
        for (let x = 0; x < size; x += 1) {
          const gx = (x / size) * cells;
          const x0 = Math.floor(gx);
          const tx = gx - x0;
          const sx = tx * tx * (3 - 2 * tx);
          const top = mix(at(x0, y0), at(x0 + 1, y0), sx);
          const bottom = mix(at(x0, y0 + 1), at(x0 + 1, y0 + 1), sx);
          field[y * size + x] += mix(top, bottom, sy) * weight;
        }
      }
    }

    for (const v of field) {
      low = Math.min(low, v);
      high = Math.max(high, v);
    }

    for (let i = 0; i < field.length; i += 1) {
      const v = Math.round(((field[i] - low) / (high - low)) * 255);
      image.data[i * 4] = v;
      image.data[i * 4 + 1] = v;
      image.data[i * 4 + 2] = v;
      image.data[i * 4 + 3] = 255;
    }

    g.putImageData(image, 0, 0);
    return c;
  })();

  function paintSun() {
    const { r } = scene.sun;
    const size = r * 2 + 4;
    const [c, g] = makeCanvas(size, size);
    const m = size / 2;

    // a warm disc, darker toward the rim as the real Sun is
    const disc = g.createRadialGradient(m - r * 0.08, m - r * 0.06, 0, m, m, r);
    disc.addColorStop(0, "#fffbe8");
    disc.addColorStop(0.35, "#ffeaa0");
    disc.addColorStop(0.72, "#ffd24d");
    disc.addColorStop(0.93, "#ffb733");
    disc.addColorStop(1, "#f59a27");
    g.fillStyle = disc;
    g.beginPath();
    g.arc(m, m, r, 0, TAU);
    g.fill();

    // granulation: a fine mottle of convection cells
    g.save();
    g.beginPath();
    g.arc(m, m, r, 0, TAU);
    g.clip();
    const cells = Math.floor(r * r * 0.025);
    for (let i = 0; i < cells; i += 1) {
      const a = seeded(i * 2.3) * TAU;
      const d = Math.sqrt(seeded(i * 5.9 + 1)) * r;
      const s = 1 + seeded(i * 8.3) * 2.6;
      g.fillStyle = seeded(i * 6.1) > 0.5 ? "rgba(255, 255, 240, 0.05)" : "rgba(200, 110, 20, 0.04)";
      g.beginPath();
      g.arc(m + Math.cos(a) * d, m + Math.sin(a) * d, s, 0, TAU);
      g.fill();
    }
    g.restore();

    layers.sun = c;
  }

  // the corona, painted once: a wide soft glow
  function paintCorona() {
    const { r } = scene.sun;
    const size = r * 7;
    const [c, g] = makeCanvas(size, size);
    const m = size / 2;

    const glow = g.createRadialGradient(m, m, r * 0.9, m, m, r * 3.2);
    glow.addColorStop(0, "rgba(255, 196, 90, 0.5)");
    glow.addColorStop(0.15, "rgba(255, 165, 70, 0.2)");
    glow.addColorStop(0.45, "rgba(255, 125, 60, 0.05)");
    glow.addColorStop(1, "rgba(255, 100, 50, 0)");
    g.fillStyle = glow;
    g.fillRect(0, 0, size, size);

    layers.corona = c;
  }

  // the Earth's ocean and air, shaded pixel by pixel against the sunlight
  function paintEarth() {
    const { r } = scene.earth;
    const size = Math.ceil(r * 2.5);
    const [c] = makeCanvas(size, size);
    const g = c.getContext("2d");
    const px = c.width;
    const scale = px / size;
    const image = g.createImageData(px, px);
    const out = image.data;
    const [lx, ly, lz] = scene.light;
    const half = [lx, ly, lz + 1];
    const hl = Math.hypot(half[0], half[1], half[2]);
    const hx = half[0] / hl;
    const hy = half[1] / hl;
    const hz = half[2] / hl;
    const flatL = Math.hypot(lx, ly) || 1;

    for (let j = 0; j < px; j += 1) {
      for (let i = 0; i < px; i += 1) {
        const x = ((i + 0.5) / scale - size / 2) / r;
        const y = ((j + 0.5) / scale - size / 2) / r;
        const d2 = x * x + y * y;
        const k = (j * px + i) * 4;
        let red = 0;
        let green = 0;
        let blue = 0;
        let alpha = 0;

        if (d2 <= 1) {
          const z = Math.sqrt(1 - d2);
          const lit = x * lx + y * ly + z * lz;
          const day = smooth(-0.18, 0.35, lit);
          const edge = Math.pow(1 - z, 2.2);
          const glint = Math.pow(Math.max(0, x * hx + y * hy + z * hz), 60) * day;

          const glow = glint * 0.55;
          red = mix(3, 10 + 22 * lit, day) + edge * 40 * day + glow * 220;
          green = mix(8, 34 + 44 * lit, day) + edge * 80 * day + glow * 210;
          blue = mix(18, 78 + 64 * lit, day) + edge * 120 * day + glow * 180;
          alpha = 255 * smooth(1, 0.985, Math.sqrt(d2));
          if (d2 > 0.97) {
            // soften the silhouette
            alpha = Math.max(alpha, 0);
          }
        } else {
          // a thin halo of air, brightest toward the Sun
          const d = Math.sqrt(d2);
          const facing = (x * lx + y * ly) / (d * flatL);
          const fall = Math.pow(1 - smooth(1, 1.12, d), 2);
          const glow = fall * (0.18 + 0.82 * smooth(-0.4, 0.9, facing));
          red = 120;
          green = 180;
          blue = 255;
          alpha = 150 * glow;
        }

        out[k] = clamp(red, 0, 255);
        out[k + 1] = clamp(green, 0, 255);
        out[k + 2] = clamp(blue, 0, 255);
        out[k + 3] = clamp(alpha, 0, 255);
      }
    }

    g.putImageData(image, 0, 0);
    layers.earth = c;
  }

  // a soft green glow for the aurora
  function makeSprites() {
    const [c, g] = makeCanvas(32, 32);
    const green = g.createRadialGradient(16, 16, 0, 16, 16, 16);
    green.addColorStop(0, "rgba(120, 255, 170, 1)");
    green.addColorStop(0.4, "rgba(80, 240, 150, 0.35)");
    green.addColorStop(1, "rgba(60, 220, 140, 0)");
    g.fillStyle = green;
    g.fillRect(0, 0, 32, 32);
    sprites.aurora = c;
  }

  /* ---------- The flow ---------- */

  // the magnetopause after Shue et al. (1998): its nose distance in Earth radii, and how it flares
  function pressure() {
    return Math.max(1.6726e-6 * vis.density * vis.speed * vis.speed, 0.05);
  }

  function standoff() {
    return (10.22 + 1.29 * Math.tanh(0.184 * (vis.bz + 8.14))) * Math.pow(pressure(), -1 / 6.6);
  }

  function flaring() {
    return (0.58 - 0.007 * vis.bz) * (1 + 0.024 * Math.log(pressure()));
  }

  // on screen the nose sits a couple of Earth radii out: sized by the real model, not to scale
  function noseDistance() {
    return scene.earth.r * Math.max(1.12, 0.6 + 0.065 * standoff());
  }

  // distance from a point (along, across the Sun–Earth line) to the magnetopause; negative inside
  function gap(along, across, nose, alpha) {
    const r = Math.hypot(along, across);
    const cos = Math.max(-0.96, -along / Math.max(r, 1e-6));
    return r - nose * Math.pow(2 / (1 + cos), alpha);
  }

  function flowSpeed() {
    return (scene.distance * vis.speed) / 3600;
  }

  function warmUp() {
    particles.length = 0;
    layers.trailsCtx.clearRect(0, 0, state.width, state.height);
    for (let i = 0; i < 16 * 30; i += 1) stepParticles(1 / 30, state.clock + i / 30);
    state.reveal = 0;
  }

  function spawn() {
    const { sun, axis } = scene;
    const spread = (Math.random() + Math.random() - 1) * 0.75;
    const angle = Math.atan2(axis.y, axis.x) + spread;
    const d = sun.r * (0.72 + Math.random() * 0.24); // under the disc, so they emerge at its edge

    particles.push({
      x: sun.x + Math.cos(angle) * d,
      y: sun.y + Math.sin(angle) * d,
      age: 0,
      life: 14 + Math.random() * 8,
      size: 0.6 + Math.random() * 0.9,
      seed: Math.random() * 1000,
      captured: 0,
      pole: 0
    });
  }

  function turbulence(x, y, t, out) {
    const k1 = 1 / 140;
    const k2 = 1 / 90;
    const k3 = 1 / 230;
    const a = x * k1 + t * 0.21;
    const b = y * k1 * 1.3 - t * 0.17;
    const c = (x - y) * k2 + t * 0.33;
    const d = x * k3 * 0.7 + y * k3 + t * 0.12;

    const dx = k1 * Math.cos(a) * Math.cos(b) + 0.6 * k2 * Math.cos(c) - 0.4 * k3 * 0.7 * Math.sin(d);
    const dy = -k1 * 1.3 * Math.sin(a) * Math.sin(b) - 0.6 * k2 * Math.cos(c) - 0.4 * k3 * Math.sin(d);
    out.x = dy / k1;
    out.y = -dx / k1;
  }

  const swirl = { x: 0, y: 0 };

  function stepParticles(dt, t) {
    const { sun, earth, axis, normal } = scene;
    const U = flowSpeed();
    const b = noseDistance();
    const alpha = flaring() * 0.72; // a slimmer flare than life, to keep the tail on screen
    const heat = clamp(Math.log10(vis.temperature / 2e4) / 1.5, 0, 1);
    const stir = U * (0.14 + heat * 0.22);
    const south = clamp(-vis.bz / 10, 0, 1);
    const target = clamp((380 + Math.sqrt(vis.density) * 175) * ((state.width * state.height) / 1.3e6), 320, 1100);

    let births = Math.min(60, Math.ceil((target / 12) * dt));
    while (births-- > 0 && particles.length < target) spawn();

    for (let i = particles.length - 1; i >= 0; i -= 1) {
      const p = particles[i];
      p.age += dt;

      const ex = p.x - earth.x;
      const ey = p.y - earth.y;
      const lx = ex * axis.x + ey * axis.y; // along the Sun–Earth line
      const ly = ex * normal.x + ey * normal.y; // across it
      const r2 = lx * lx + ly * ly;
      const r = Math.sqrt(r2);

      if (r < earth.r * 1.02 || p.age > p.life) {
        particles.splice(i, 1);
        continue;
      }

      let vx;
      let vy;

      if (p.captured) {
        // pulled along the field lines toward a pole
        const px = earth.x + scene.basis.p[0] * earth.r * 0.92 * p.pole;
        const py = earth.y + scene.basis.p[1] * earth.r * 0.92 * p.pole;
        const tx = px - p.x;
        const ty = py - p.y;
        const tl = Math.hypot(tx, ty);
        if (tl < earth.r * 0.12) {
          state.aurora = Math.min(1, state.aurora + 0.012);
          particles.splice(i, 1);
          continue;
        }
        const bend = 0.5 * U;
        vx = (tx / tl) * U * 0.8 + ((-ty / tl) * bend * p.pole * 0.3);
        vy = (ty / tl) * U * 0.8 + ((tx / tl) * bend * p.pole * 0.3);
      } else {
        // leaving the Sun radially, straightening into a stream toward the Earth
        const sx = p.x - sun.x;
        const sy = p.y - sun.y;
        const sd = Math.hypot(sx, sy);
        const straight = smooth(sun.r, sun.r + scene.distance * 0.55, sd);
        let fx = mix(sx / sd, axis.x, straight);
        let fy = mix(sy / sd, axis.y, straight);
        const fl = Math.hypot(fx, fy);
        fx = (fx / fl) * U;
        fy = (fy / fl) * U;

        // the magnetic bubble parts the stream: near the boundary the particles turn to run along it
        const g0 = gap(lx, ly, b, alpha);
        const layer = b * 1.4;
        vx = fx;
        vy = fy;

        if (g0 < layer) {
          const e = 1.5;
          const gx = (gap(lx + e, ly, b, alpha) - gap(lx - e, ly, b, alpha)) / (2 * e);
          const gy = (gap(lx, ly + e, b, alpha) - gap(lx, ly - e, b, alpha)) / (2 * e);
          const gl = Math.hypot(gx, gy) || 1;
          const nx = gx / gl; // outward normal, in (along, across)
          const ny = gy / gl;
          let tx = -ny;
          let ty = nx;
          if (tx < 0) {
            tx = -tx;
            ty = -ty;
          }

          const hold = 1 - smooth(0, layer, g0);
          const front = smooth(-0.2, 0.8, -lx / Math.max(r, 1)); // slowest at the sunward nose

          // split the stream into parts across and along the boundary; the part heading
          // into it fades as the gap closes, so the particles crowd into a sheath and slide past
          const fu = fx * axis.x + fy * axis.y;
          const fv = fx * normal.x + fy * normal.y;
          let across = fu * nx + fv * ny;
          const alongIt = fu * tx + fv * ty;
          if (across < 0) across *= clamp(g0 / layer, 0, 1);
          if (g0 < 0) across += (-g0 / b) * U * 2;

          const speed = Math.hypot(fu, fv) * (1 - hold * front * 0.5);
          const flow = Math.max(alongIt, 0.25 * speed);
          const au = tx * flow + nx * across;
          const av = ty * flow + ny * across;
          const al = Math.hypot(au, av) || 1;
          const kept = Math.min(1, speed / al) * al;

          vx = ((au * axis.x + av * normal.x) / al) * kept;
          vy = ((au * axis.y + av * normal.y) / al) * kept;
          p.hold = hold;
        } else {
          p.hold = 0;
        }

        // a southward field opens the door at the nose, and some of the wind slips in
        if (south > 0 && lx < 0 && r < b * 1.25 && Math.abs(ly) < b * 0.9) {
          if (Math.random() < south * dt * 1.4) {
            p.captured = 1;
            p.pole = ex * scene.basis.p[0] + ey * scene.basis.p[1] >= 0 ? 1 : -1;
            p.life = p.age + 8;
          }
        }
      }

      turbulence(p.x + p.seed, p.y - p.seed, t, swirl);
      const calm = smooth(sun.r * 0.9, sun.r * 1.6, Math.hypot(p.x - sun.x, p.y - sun.y)) * (1 - (p.hold || 0) * 0.8);
      p.vx = vx + swirl.x * stir * calm;
      p.vy = vy + swirl.y * stir * calm;
      p.px = p.x;
      p.py = p.y;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.downstream = smooth(0, b * 3.5, lx);

      const margin = 80;
      if (p.x < -margin || p.y < -margin || p.x > state.width + margin || p.y > state.height + margin) {
        particles.splice(i, 1);
      }
    }
  }

  // white-gold at the Sun, pale gold in flight, warm ash as it cools, brighter where it piles up
  const TONES = [
    [255, 246, 222],
    [255, 222, 164],
    [236, 214, 196],
    [255, 206, 170]
  ];
  const LEVELS = 5;
  const strokes = Array.from({ length: TONES.length * LEVELS }, () => []);

  function drawStreams(dt) {
    const g = layers.trailsCtx;
    const w = state.width;
    const h = state.height;

    // old segments fade, so each particle trails a short tail behind it
    g.globalCompositeOperation = "destination-out";
    g.fillStyle = `rgba(0, 0, 0, ${1 - Math.pow(0.86, dt * 60)})`;
    g.fillRect(0, 0, w, h);

    for (const bucket of strokes) bucket.length = 0;
    const thickness = clamp(0.5 + Math.sqrt(vis.density) / 8, 0.55, 1);

    for (const p of particles) {
      if (p.px === undefined) continue;
      const fadeIn = smooth(0, 0.25, p.age);
      const fadeOut = (1 - smooth(p.life - 2, p.life, p.age)) * (1 - (p.downstream || 0) * 0.85);
      const travelled = clamp(Math.hypot(p.x - scene.sun.x, p.y - scene.sun.y) / scene.distance, 0, 1);
      const nearShock = p.hold || 0;

      let tone = Math.min(2, Math.floor(travelled * 3));
      if (nearShock > 0.35 || p.captured) tone = 3;

      const alpha = thickness * fadeIn * fadeOut * (0.55 + nearShock * 0.45);
      const level = Math.min(LEVELS - 1, Math.floor(alpha * LEVELS));
      if (alpha < 0.04) continue;
      strokes[tone * LEVELS + level].push(p.px, p.py, p.x, p.y);
    }

    g.globalCompositeOperation = "lighter";
    g.lineCap = "round";
    g.lineWidth = 0.9;

    strokes.forEach((bucket, index) => {
      if (!bucket.length) return;
      const [red, green, blue] = TONES[Math.floor(index / LEVELS)];
      const level = (index % LEVELS) + 1;
      g.strokeStyle = `rgba(${red}, ${green}, ${blue}, ${(level / LEVELS) * 0.8})`;
      g.beginPath();
      for (let i = 0; i < bucket.length; i += 4) {
        g.moveTo(bucket[i], bucket[i + 1]);
        g.lineTo(bucket[i + 2], bucket[i + 3]);
      }
      g.stroke();
    });
  }

  /* ---------- Drawing ---------- */

  // flare strength from the X-ray class: B = 0, C ≈ 0.33, M ≈ 0.67, X = 1
  const flareLevel = () => clamp((Math.log10(vis.flare) + 7) / 3, 0, 1);

  function drawCorona(t) {
    const { x, y } = scene.sun;
    const flare = flareLevel();
    const breathe = 1 + Math.sin(t * 0.35) * 0.03 + Math.sin(t * 0.13) * 0.02;

    ctx.save();
    ctx.globalCompositeOperation = "lighter";

    const size = (layers.corona.width / state.dpr) * breathe * (1 + flare * 0.25);
    ctx.globalAlpha = 0.85 + flare * 0.15;
    ctx.translate(x, y);
    ctx.rotate(t * 0.006);
    ctx.drawImage(layers.corona, -size / 2, -size / 2, size, size);

    ctx.restore();
  }

  function drawDisc(t) {
    const { x, y, r } = scene.sun;
    const flare = flareLevel();

    // the disc itself, turning very slowly
    const disc = layers.sun.width / state.dpr;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(t * 0.004);
    ctx.drawImage(layers.sun, -disc / 2, -disc / 2, disc, disc);
    ctx.restore();

    drawSurface(t);

    // a flare lifts the whole disc
    if (flare > 0.3) {
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = (flare - 0.3) * 0.5 * (0.8 + Math.sin(t * 2.1) * 0.2);
      ctx.fillStyle = "#fff2c8";
      ctx.beginPath();
      ctx.arc(x, y, r, 0, TAU);
      ctx.fill();
      ctx.restore();
    }
  }

  // the surface stirs: two layers of fractal noise drift apart and cross-fade, just enough to see
  let surfacePattern = null;

  function drawSurface(t) {
    const { x, y, r } = scene.sun;
    surfacePattern = surfacePattern || ctx.createPattern(surface, "repeat");
    const tile = (r * 1.1) / surface.width;
    const pace = scene.portrait ? 0.5 : 1; // the phone's smaller Sun reads faster, so slow it
    const layersOf = [
      { scale: tile, dx: 7 * pace, dy: 2.5 * pace, phase: 0 },
      { scale: tile * 0.62, dx: -4.5 * pace, dy: 5 * pace, phase: Math.PI }
    ];

    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, r * 0.995, 0, TAU);
    ctx.clip();
    ctx.globalCompositeOperation = "soft-light";

    for (const layer of layersOf) {
      const weight = 0.5 + 0.5 * Math.sin(t * 0.22 * pace + layer.phase);
      surfacePattern.setTransform(
        new DOMMatrix()
          .translate(x + layer.dx * t, y + layer.dy * t)
          .scale(layer.scale)
      );
      ctx.globalAlpha = 0.3 + 0.3 * weight;
      ctx.fillStyle = surfacePattern;
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
    }

    ctx.restore();
  }

  const buckets = Array.from({ length: 10 }, () => []);

  function drawEarth(spin) {
    const { x, y, r } = scene.earth;
    const size = layers.earth.width / state.dpr;
    ctx.drawImage(layers.earth, x - size / 2, y - size / 2, size, size);

    // continents as a lattice of dots, warm in daylight and faint blue at night
    for (const bucket of buckets) bucket.length = 0;
    const dotSize = Math.max(1.1, r / 70);

    for (const point of land) {
      const v = toScreen(point.cl, point.sl, point.lon, spin);
      if (v[2] <= 0.02) continue;
      const day = smooth(-0.12, 0.3, dot3(v, scene.light));
      const level = Math.min(9, Math.floor(day * 10));
      buckets[level].push(x + v[0] * r, y + v[1] * r, dotSize * (0.5 + 0.5 * v[2]));
    }

    for (let level = 0; level < 10; level += 1) {
      const bucket = buckets[level];
      if (!bucket.length) continue;
      const day = level / 9;
      const red = Math.round(mix(70, 244, day));
      const green = Math.round(mix(110, 232, day));
      const blue = Math.round(mix(170, 204, day));
      ctx.fillStyle = `rgba(${red}, ${green}, ${blue}, ${mix(0.32, 0.92, day)})`;
      ctx.beginPath();
      for (let i = 0; i < bucket.length; i += 3) {
        const s = bucket[i + 2];
        ctx.rect(bucket[i] - s / 2, bucket[i + 1] - s / 2, s, s);
      }
      ctx.fill();
    }

    drawAurora(spin);
  }

  // auroral ovals ring the geomagnetic poles and widen as activity rises
  const MAG_POLES = [
    { lat: (80.7 * Math.PI) / 180, lon: (-72.7 * Math.PI) / 180 },
    { lat: (-80.7 * Math.PI) / 180, lon: (107.3 * Math.PI) / 180 }
  ];

  function drawAurora(spin) {
    const { x, y, r } = scene.earth;
    const south = clamp(-vis.bz / 12, 0, 1);
    const strength = clamp(0.12 + vis.kp / 10 + south * 0.35 + state.aurora, 0, 1.4);
    if (strength < 0.02) return;

    const colatitude = ((17 + vis.kp * 1.9) * Math.PI) / 180;

    ctx.save();
    ctx.globalCompositeOperation = "lighter";

    for (const pole of MAG_POLES) {
      // two directions perpendicular to the pole, for walking around it
      const center = [Math.cos(pole.lat) * Math.cos(pole.lon), Math.cos(pole.lat) * Math.sin(pole.lon), Math.sin(pole.lat)];
      const e1 = norm3(cross3(center, [0, 0, 1]));
      const e2 = cross3(center, e1);

      for (let i = 0; i < 96; i += 1) {
        const a = (i / 96) * TAU;
        const ring = [
          center[0] * Math.cos(colatitude) + Math.sin(colatitude) * (Math.cos(a) * e1[0] + Math.sin(a) * e2[0]),
          center[1] * Math.cos(colatitude) + Math.sin(colatitude) * (Math.cos(a) * e1[1] + Math.sin(a) * e2[1]),
          center[2] * Math.cos(colatitude) + Math.sin(colatitude) * (Math.cos(a) * e1[2] + Math.sin(a) * e2[2])
        ];
        const lat = Math.asin(ring[2]);
        const lon = Math.atan2(ring[1], ring[0]);
        const v = toScreen(Math.cos(lat), Math.sin(lat), lon, spin);
        if (v[2] < -0.08) continue;

        // curtains: brightest on the night side, rippling and uneven around the ring
        const night = 1 - smooth(-0.25, 0.3, dot3(v, scene.light));
        const ripple = 0.5 + 0.5 * Math.sin(a * 7 + state.clock * 0.9 + pole.lat) * Math.sin(a * 3 - state.clock * 0.4);
        const alpha = strength * (0.02 + night * 0.3) * (0.35 + 0.65 * ripple) * smooth(-0.08, 0.2, v[2]);
        if (alpha < 0.01) continue;

        const glow = r * (0.08 + 0.06 * ripple);
        const lift = 1.02 + 0.03 * ripple;
        ctx.globalAlpha = Math.min(0.32, alpha);
        ctx.drawImage(sprites.aurora, x + v[0] * r * lift - glow, y + v[1] * r * lift - glow, glow * 2, glow * 2);
      }
    }

    ctx.restore();
  }

  // a small marker where the wind is measured, a million miles out
  function drawL1() {
    const { earth, axis } = scene;
    const b = noseDistance();
    const d = b + (scene.distance - scene.sun.r - b) * 0.22;
    const x = earth.x - axis.x * d;
    const y = earth.y - axis.y * d;

    ctx.save();
    ctx.globalAlpha = 0.55;
    ctx.strokeStyle = "rgba(239, 233, 220, 0.8)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, y - 4);
    ctx.lineTo(x + 4, y);
    ctx.lineTo(x, y + 4);
    ctx.lineTo(x - 4, y);
    ctx.closePath();
    ctx.stroke();
    ctx.fillStyle = "rgba(239, 233, 220, 0.8)";
    ctx.font = `10px ${getComputedStyle(document.body).fontFamily}`;
    ctx.textAlign = "center";
    ctx.fillText("L1", x, y - 11);
    ctx.restore();
  }

  function ease(dt) {
    const k = 1 - Math.exp(-dt * 0.6);
    vis.speed += (data.speed - vis.speed) * k;
    vis.density += (data.density - vis.density) * k;
    vis.temperature += (data.temperature - vis.temperature) * k;
    vis.bz += (data.bz - vis.bz) * k;
    vis.kp += (data.kp - vis.kp) * k;
    vis.flare += (data.flare - vis.flare) * k;
    state.aurora *= Math.exp(-dt * 0.5);
  }

  function frame(now) {
    requestAnimationFrame(frame);

    const dt = Math.min(0.05, (now - state.last) / 1000);
    state.last = now;
    if (state.paused) return;
    render(dt);
  }

  function render(dt) {
    const pace = reduceMotion ? 0.3 : 1;
    state.clock += dt * pace;
    const t = state.clock;
    ease(dt);

    if (state.running) stepParticles(dt * pace, t);

    ctx.globalCompositeOperation = "source-over";
    ctx.drawImage(layers.stars, 0, 0, state.width, state.height);
    drawCorona(t);

    drawStreams(dt * pace);
    state.reveal = Math.min(1, state.reveal + dt / 1.5);
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = smooth(0, 1, state.reveal);
    ctx.drawImage(layers.trails, 0, 0, state.width, state.height);
    ctx.restore();

    drawDisc(t);

    if (state.running) drawL1();
    drawEarth(scene.spin0 + (t / SPIN_SECONDS) * TAU);
  }

  /* ---------- Data ---------- */

  async function getJSON(url) {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) throw new Error(`${url}: ${response.status}`);
    return response.json();
  }

  // the feeds carry every spacecraft; average the last ten minutes of the active one
  function recent(rows, key) {
    const values = rows
      .filter((row) => row.active && Number.isFinite(row[key]))
      .sort((a, b) => (a.time_tag < b.time_tag ? 1 : -1))
      .slice(0, 10);
    if (!values.length) return null;
    return {
      value: values.reduce((sum, row) => sum + row[key], 0) / values.length,
      time: new Date(`${values[0].time_tag}Z`)
    };
  }

  // Kp is estimated in three-hour windows and restarts near zero as each one opens,
  // so for the first half hour of a window keep the one that just closed
  function latestKp(rows) {
    const latest = rows[rows.length - 1];
    const time = new Date(`${latest.time_tag}Z`);
    const opened = Date.UTC(time.getUTCFullYear(), time.getUTCMonth(), time.getUTCDate(), Math.floor(time.getUTCHours() / 3) * 3);
    if (time - opened >= 30 * 60 * 1000) return latest.estimated_kp;

    const before = rows.filter((row) => new Date(`${row.time_tag}Z`) < opened);
    return before.length ? before[before.length - 1].estimated_kp : latest.estimated_kp;
  }

  function flareFlux(label) {
    const scale = { A: 1e-8, B: 1e-7, C: 1e-6, M: 1e-5, X: 1e-4 };
    const match = /^([ABCMX])([\d.]+)/.exec(label || "");
    return match ? scale[match[1]] * Number(match[2]) : null;
  }

  async function loadData() {
    data.lastFetch = Date.now();
    const [wind, mag, kp, flare] = await Promise.allSettled([
      getJSON(FEEDS.wind),
      getJSON(FEEDS.mag),
      getJSON(FEEDS.kp),
      getJSON(FEEDS.flare)
    ]);

    let fresh = false;

    if (wind.status === "fulfilled") {
      const speed = recent(wind.value, "proton_speed");
      const density = recent(wind.value, "proton_density");
      const temperature = recent(wind.value, "proton_temperature");
      if (speed) {
        data.speed = speed.value;
        data.time = speed.time;
        fresh = true;
      }
      if (density) data.density = density.value;
      if (temperature) data.temperature = temperature.value;
    }

    if (mag.status === "fulfilled") {
      const bz = recent(mag.value, "bz_gsm");
      const bt = recent(mag.value, "bt");
      if (bz) data.bz = bz.value;
      if (bt) data.bt = bt.value;
    }

    if (kp.status === "fulfilled" && kp.value.length) {
      const latest = latestKp(kp.value);
      if (Number.isFinite(latest)) data.kp = latest;
    }

    if (flare.status === "fulfilled" && flare.value.length) {
      const flux = flareFlux(flare.value[0].current_class);
      if (flux) data.flare = flux;
    }

    for (const result of [wind, mag, kp, flare]) {
      if (result.status === "rejected") console.warn(result.reason);
    }

    if (fresh) {
      data.measured = true;
      renderReading();
    } else if (!data.measured) {
      conditionEl.textContent = "The Sun is breathing somewhere out of reach.";
      arrivalEl.textContent = "";
      detailsEl.textContent = "";
    }

    statusEl.textContent = statusText();
    updateSound();
  }

  function condition() {
    if (data.kp >= 7) return "A severe geomagnetic storm. Auroras may reach far from the poles.";
    if (data.kp >= 5) return "A geomagnetic storm is under way. The auroras are bright.";
    if (data.speed >= 600) return "A fast stream is pouring past the Earth.";
    if (data.bz <= -6) return "The wind's field has turned south, and the poles are open to it.";
    if (data.speed >= 480) return "A brisk wind is streaming from the Sun.";
    if (data.speed >= 360) return "A steady wind is flowing from the Sun.";
    return "The Sun is breathing quietly.";
  }

  function renderReading() {
    conditionEl.textContent = condition();

    const minutes = Math.round(L1_KM / data.speed / 60);
    arrivalEl.textContent = `This wind reaches the Earth in ${minutes} minutes`;

    // two halves, so a narrow screen can stack them
    const bz = data.bz.toFixed(1).replace("-", "−");
    const flow = document.createElement("span");
    const field = document.createElement("span");
    flow.textContent = `${Math.round(data.speed)} km/s · ${data.density.toFixed(1)} p/cm³`;
    field.textContent = `Bz ${bz} nT · Kp ${data.kp.toFixed(1)}`;
    detailsEl.replaceChildren(flow, field);
  }

  function statusText() {
    if (!data.measured) return "Solar wind data unavailable · drifting on a typical day";
    const time = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(data.time);
    return `Measured ${time} · NOAA SWPC`;
  }

  function refreshIfStale() {
    if (!document.hidden && Date.now() - data.lastFetch >= REFRESH_MS) loadData();
  }

  /* ---------- Sound: a low wind whose pitch follows the solar wind's speed ---------- */

  const audio = { ctx: null, filter: null, gain: null };

  function initAudio() {
    if (audio.ctx) return;
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    const length = ac.sampleRate * 4;
    const buffer = ac.createBuffer(2, length, ac.sampleRate);

    for (let channel = 0; channel < 2; channel += 1) {
      const out = buffer.getChannelData(channel);
      let last = 0;
      for (let i = 0; i < length; i += 1) {
        last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02; // brown noise
        out[i] = last * 3.5;
      }
    }

    const source = ac.createBufferSource();
    source.buffer = buffer;
    source.loop = true;

    const filter = ac.createBiquadFilter();
    filter.type = "lowpass";
    filter.Q.value = 0.8;

    const gain = ac.createGain();
    gain.gain.value = 0;

    const lfo = ac.createOscillator();
    lfo.frequency.value = 0.07;
    const depth = ac.createGain();
    depth.gain.value = 60;
    lfo.connect(depth);
    depth.connect(filter.frequency);

    source.connect(filter);
    filter.connect(gain);
    gain.connect(ac.destination);
    source.start();
    lfo.start();

    Object.assign(audio, { ctx: ac, filter, gain });
  }

  function updateSound() {
    if (!audio.ctx) return;
    const on = state.soundOn && state.running && !state.paused;
    const now = audio.ctx.currentTime;
    audio.filter.frequency.setTargetAtTime(160 + (data.speed - 300) * 0.9, now, 2);
    audio.gain.gain.setTargetAtTime(on ? clamp(0.18 + data.density / 40, 0.15, 0.45) : 0, now, on ? 1.5 : 0.5);
  }

  function toggleSound() {
    state.soundOn = !state.soundOn;
    soundToggle.textContent = `Sound: ${state.soundOn ? "On" : "Off"}`;
    soundToggle.setAttribute("aria-pressed", String(state.soundOn));
    if (state.soundOn) {
      initAudio();
      if (audio.ctx.state === "suspended") audio.ctx.resume();
    }
    updateSound();
  }

  /* ---------- Controls ---------- */

  function begin() {
    if (state.running) return;
    state.running = true;
    state.paused = false;
    reading.hidden = false;
    detailsEl.hidden = false;
    void reading.offsetWidth; // lay out the reading first so it fades in
    document.body.classList.add("running");
    startButton.textContent = "Pause";
    warmUp();
    updateSound();
  }

  // one button: Begin, then Pause and Resume
  function togglePause() {
    if (!state.running) {
      begin();
      return;
    }
    state.paused = !state.paused;
    startButton.textContent = state.paused ? "Resume" : "Pause";
    statusEl.textContent = state.paused ? "The wind is held." : statusText();
    updateSound();
  }

  let hideTimer = null;

  function showControls() {
    document.body.classList.add("controls-visible");
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => document.body.classList.remove("controls-visible"), 3500);
  }

  function toggleAbout(force) {
    const open = typeof force === "boolean" ? force : aboutPanel.hidden;
    aboutPanel.hidden = !open;
    aboutButton.setAttribute("aria-expanded", String(open));
    if (open) closeAbout.focus();
    else aboutButton.focus();
  }

  function toggleMark(force) {
    const open = typeof force === "boolean" ? force : markCard.hidden;
    markCard.hidden = !open;
    mark.setAttribute("aria-expanded", String(open));
  }

  startButton.addEventListener("click", togglePause);
  soundToggle.addEventListener("click", toggleSound);
  aboutButton.addEventListener("click", () => toggleAbout());
  closeAbout.addEventListener("click", () => toggleAbout(false));
  mark.addEventListener("click", () => toggleMark());

  // the meaning card closes with Escape or a click anywhere outside it
  window.addEventListener("pointerdown", (event) => {
    if (!event.target.closest("#markCard, #mark")) toggleMark(false);
  });

  window.addEventListener("keydown", (event) => {
    if (event.code === "Space" && !event.repeat) {
      event.preventDefault();
      togglePause();
    }
    if (event.key === "Escape") {
      if (!aboutPanel.hidden) toggleAbout(false);
      toggleMark(false);
    }
  });

  let lastMove = 0;
  window.addEventListener("mousemove", () => {
    if (!state.running || Date.now() - lastMove < 200) return;
    lastMove = Date.now();
    showControls();
  });
  window.addEventListener("touchstart", () => state.running && showControls(), { passive: true });

  let resizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(resize, 120);
  });

  // for tuning: ?debug exposes the data and can fast-forward the scene, e.g. __advance(20)
  if (location.search.includes("debug")) {
    window.__data = data;
    window.__particles = particles;
    window.__vis = vis;
    window.__advance = (seconds) => {
      for (let i = 0; i < seconds * 30; i += 1) render(1 / 30);
    };
  }

  resize();
  requestAnimationFrame((now) => {
    state.last = now;
    frame(now);
  });

  loadData();
  setInterval(refreshIfStale, 60 * 1000);
  document.addEventListener("visibilitychange", refreshIfStale);
})();
