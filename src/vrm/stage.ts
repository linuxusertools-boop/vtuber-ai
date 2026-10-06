// @ts-nocheck — three.js dimuat dinamis (code-split); tipe diabaikan di file ini.
// Panggung: pencahayaan sinematik, sorot cahaya volumetrik dari atas, kabut lantai,
// kabut melayang, embun/debu bercahaya, kolam cahaya & bayangan kontak.
// Semua prosedural (tanpa file gambar) dan ringan: partikel dihitung di GPU.

export type Quality = "high" | "mid" | "low";
export interface StageOpts {
  quality: Quality;
  light: number; // pengali intensitas cahaya
  mist: number; // pengali kabut
  rays: number; // pengali sorot cahaya
  particles: number; // pengali jumlah partikel
}

function radialTexture(T, size, stops) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d");
  const gr = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [o, col] of stops) gr.addColorStop(o, col);
  g.fillStyle = gr;
  g.fillRect(0, 0, size, size);
  const tex = new T.CanvasTexture(c);
  tex.colorSpace = T.SRGBColorSpace;
  return tex;
}

function cloudTexture(T, size) {
  // fBm value-noise × pudaran radial → awan lembut yang tepinya hilang
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d");
  const img = g.createImageData(size, size);
  const N = 64;
  const grid = new Float32Array(N * N).map(() => Math.random());
  const val = (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    const fx = x - xi, fy = y - yi;
    const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
    const a = grid[((yi % N) + N) % N * N + (((xi % N) + N) % N)];
    const b = grid[((yi % N) + N) % N * N + (((xi + 1) % N + N) % N)];
    const c2 = grid[(((yi + 1) % N + N) % N) * N + (((xi % N) + N) % N)];
    const d = grid[(((yi + 1) % N + N) % N) * N + (((xi + 1) % N + N) % N)];
    return a + (b - a) * u + (c2 - a) * v + (a - b - c2 + d) * u * v;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let n = 0, amp = 0.5, f = 3.5;
      for (let o = 0; o < 4; o++) {
        n += val((x / size) * f * 2, (y / size) * f * 2) * amp;
        amp *= 0.5;
        f *= 2;
      }
      const dx = (x / size - 0.5) * 2, dy = (y / size - 0.5) * 2;
      const fall = Math.max(0, 1 - Math.sqrt(dx * dx + dy * dy));
      const a = Math.pow(Math.max(0, n - 0.22) * 1.7, 1.2) * Math.pow(fall, 1.4);
      const i = (y * size + x) * 4;
      img.data[i] = 255; img.data[i + 1] = 255; img.data[i + 2] = 255;
      img.data[i + 3] = Math.max(0, Math.min(255, a * 255));
    }
  }
  g.putImageData(img, 0, 0);
  const tex = new T.CanvasTexture(c);
  tex.colorSpace = T.SRGBColorSpace;
  return tex;
}

export function createStage(T, scene, o: StageOpts) {
  const q = o.quality;
  const cnt = (hi, mid, lo) => Math.max(0, Math.round((q === "high" ? hi : q === "mid" ? mid : lo)));
  const disposables = [];
  const group = new T.Group();
  group.name = "stage";
  scene.add(group);

  // ── cahaya ────────────────────────────────────────────────────────────────
  const L = o.light;
  const hemi = new T.HemisphereLight(0xdfe6ff, 0x4a3f5e, 1.0 * L);
  const key = new T.DirectionalLight(0xfff1dc, 1.7 * L);
  key.position.set(-0.8, 2.2, 1.6);
  const top = new T.DirectionalLight(0xe8f0ff, 1.05 * L);
  top.position.set(0.1, 4, 0.3);
  const rim = new T.DirectionalLight(0x9fb8ff, 1.5 * L);
  rim.position.set(1.4, 1.6, -1.8);
  const fill = new T.DirectionalLight(0xffc9d8, 0.45 * L);
  fill.position.set(1.6, 0.8, 1.2);
  group.add(hemi, key, top, rim, fill);

  // ── sorot cahaya volumetrik dari atas ─────────────────────────────────────
  const rayMats = [];
  const rayDefs = [
    { x: 0.0, z: -0.25, r: 1.15, h: 4.6, i: 0.2, tilt: 0 },
    { x: -0.55, z: -0.5, r: 0.55, h: 4.6, i: 0.13, tilt: 0.08 },
    { x: 0.6, z: -0.4, r: 0.5, h: 4.6, i: 0.11, tilt: -0.09 },
  ].slice(0, cnt(3, 2, 1));
  const rayVS = `varying vec3 vN; varying vec3 vV; varying float vT; varying float vA;
    void main(){ vec4 mv = modelViewMatrix*vec4(position,1.0); vN = normalize(normalMatrix*normal); vV = normalize(-mv.xyz);
      vT = position.y/${(4.6).toFixed(1)} + 0.5; vA = atan(position.z, position.x); gl_Position = projectionMatrix*mv; }`;
  const rayFS = `uniform float uTime; uniform float uI; uniform vec3 uC; varying vec3 vN; varying vec3 vV; varying float vT; varying float vA;
    void main(){ float f = pow(abs(dot(normalize(vN), normalize(vV))), 2.2);
      float shaft = 0.82 + 0.18*sin(vA*9.0 + uTime*0.35) * sin(vA*4.0 - uTime*0.21);
      float a = f * pow(clamp(vT,0.0,1.0), 1.1) * smoothstep(0.0,0.14,vT) * shaft * uI;
      gl_FragColor = vec4(uC*a, a); }`;
  for (const d of rayDefs) {
    const geo = new T.ConeGeometry(d.r, d.h, q === "low" ? 24 : 48, 1, true);
    const mat = new T.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uI: { value: d.i * o.rays }, uC: { value: new T.Color(0xfff2d8) } },
      vertexShader: rayVS, fragmentShader: rayFS, transparent: true, depthWrite: false, side: T.DoubleSide, blending: T.AdditiveBlending,
    });
    const m = new T.Mesh(geo, mat);
    m.position.set(d.x, d.h / 2, d.z);
    m.rotation.z = d.tilt;
    m.renderOrder = 6;
    m.frustumCulled = false;
    group.add(m);
    rayMats.push({ mat, base: d.i * o.rays });
    disposables.push(geo, mat);
  }

  // ── kolam cahaya + bayangan kontak ────────────────────────────────────────
  const poolTex = radialTexture(T, 128, [[0, "rgba(255,244,220,0.9)"], [0.45, "rgba(255,240,210,0.28)"], [1, "rgba(255,240,210,0)"]]);
  const pool = new T.Mesh(new T.PlaneGeometry(2.4, 2.4), new T.MeshBasicMaterial({ map: poolTex, transparent: true, depthWrite: false, blending: T.AdditiveBlending, opacity: 0.45 * o.rays }));
  pool.rotation.x = -Math.PI / 2; pool.position.set(0, 0.004, -0.05); pool.renderOrder = 1;
  const shTex = radialTexture(T, 96, [[0, "rgba(0,0,0,0.55)"], [0.6, "rgba(0,0,0,0.22)"], [1, "rgba(0,0,0,0)"]]);
  const shadow = new T.Mesh(new T.PlaneGeometry(1.1, 0.8), new T.MeshBasicMaterial({ map: shTex, transparent: true, depthWrite: false }));
  shadow.rotation.x = -Math.PI / 2; shadow.position.set(0, 0.006, 0); shadow.renderOrder = 2;
  group.add(pool, shadow);
  disposables.push(poolTex, shTex, pool.geometry, pool.material, shadow.geometry, shadow.material);

  // ── kabut ─────────────────────────────────────────────────────────────────
  const cloud = cloudTexture(T, q === "high" ? 256 : q === "mid" ? 192 : 128);
  disposables.push(cloud);
  const mists = [];
  const nPlanes = cnt(7, 5, 3);
  for (let i = 0; i < nPlanes; i++) {
    const size = 3.2 + Math.random() * 2.6;
    const mat = new T.MeshBasicMaterial({ map: cloud, transparent: true, depthWrite: false, opacity: 0, color: new T.Color(i % 2 ? 0xd6e0ff : 0xfff0f6) });
    const m = new T.Mesh(new T.PlaneGeometry(size, size), mat);
    m.rotation.x = -Math.PI / 2;
    m.position.set((Math.random() - 0.5) * 1.6, 0.03 + i * 0.07, -0.9 + (i / nPlanes) * 1.9);
    m.renderOrder = 3 + (i % 3);
    group.add(m);
    mists.push({ m, mat, spd: (Math.random() - 0.5) * 0.06, ph: Math.random() * 6.28, base: (0.16 + Math.random() * 0.12) * o.mist, drift: 0.12 + Math.random() * 0.2, x0: m.position.x });
    disposables.push(m.geometry, mat);
  }
  const nWisp = cnt(8, 5, 2);
  for (let i = 0; i < nWisp; i++) {
    const mat = new T.SpriteMaterial({ map: cloud, transparent: true, depthWrite: false, opacity: 0, color: 0xcfd9ff });
    const sp = new T.Sprite(mat);
    const s = 2.2 + Math.random() * 2;
    sp.scale.set(s, s * 0.7, 1);
    sp.position.set((Math.random() - 0.5) * 3, 0.5 + Math.random() * 1.4, -1.0 - Math.random() * 1.6);
    sp.renderOrder = 0;
    group.add(sp);
    mists.push({ sprite: sp, mat, ph: Math.random() * 6.28, base: (0.07 + Math.random() * 0.07) * o.mist, drift: 0.25 + Math.random() * 0.3, x0: sp.position.x, spd: 0 });
    disposables.push(mat);
  }

  // ── embun / debu bercahaya (GPU) ──────────────────────────────────────────
  let dust = null;
  const nDust = Math.round(cnt(170, 100, 45) * o.particles);
  if (nDust > 0) {
    const pos = new Float32Array(nDust * 3);
    const seed = new Float32Array(nDust * 4);
    for (let i = 0; i < nDust; i++) {
      pos[i * 3] = (Math.random() - 0.5) * 2.4; pos[i * 3 + 1] = Math.random() * 2.4; pos[i * 3 + 2] = (Math.random() - 0.5) * 1.8 - 0.1;
      for (let j = 0; j < 4; j++) seed[i * 4 + j] = Math.random();
    }
    const g = new T.BufferGeometry();
    g.setAttribute("position", new T.BufferAttribute(pos, 3));
    g.setAttribute("seed", new T.BufferAttribute(seed, 4));
    const mat = new T.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uScale: { value: 600 } },
      vertexShader: `attribute vec4 seed; uniform float uTime; uniform float uScale; varying float vTw;
        void main(){ vec3 p = position; p.y = mod(position.y + uTime*(0.015+seed.w*0.035), 2.4);
          p.x += sin(uTime*(0.2+seed.z*0.4)+seed.x*6.28)*0.07; p.z += cos(uTime*(0.17+seed.y*0.3)+seed.z*6.28)*0.07;
          vec4 mv = modelViewMatrix*vec4(p,1.0); gl_Position = projectionMatrix*mv;
          gl_PointSize = (0.012+seed.y*0.02)*uScale/(-mv.z);
          vTw = 0.35+0.65*pow(0.5+0.5*sin(uTime*(0.8+seed.w*2.2)+seed.x*30.0), 3.0); }`,
      fragmentShader: `varying float vTw; void main(){ float d = length(gl_PointCoord-0.5)*2.0; float a = smoothstep(1.0,0.0,d); gl_FragColor = vec4(vec3(1.0,0.96,0.88)*a*vTw, a*vTw*0.85); }`,
      transparent: true, depthWrite: false, blending: T.AdditiveBlending,
    });
    dust = new T.Points(g, mat);
    dust.frustumCulled = false; dust.renderOrder = 7;
    group.add(dust);
    disposables.push(g, mat);
  }

  const rimBase = rim.intensity, keyBase = key.intensity, topBase = top.intensity;
  return {
    group,
    setViewportHeight(h) { if (dust) dust.material.uniforms.uScale.value = h * 0.9; },
    update(t, voice = 0) {
      // cahaya "bernapas" pelan agar tidak terasa statis
      const fl = 1 + 0.022 * Math.sin(t * 1.3) + 0.013 * Math.sin(t * 3.1 + 2);
      top.intensity = topBase * fl;
      key.intensity = keyBase * (1 + 0.012 * Math.sin(t * 0.7 + 1)) * (1 + voice * 0.04);
      rim.intensity = rimBase * (1 + 0.03 * Math.sin(t * 0.9 + 4));
      for (const r of rayMats) { r.mat.uniforms.uTime.value = t; r.mat.uniforms.uI.value = r.base * fl; }
      if (dust) dust.material.uniforms.uTime.value = t;
      for (const m of mists) {
        const k = 0.5 + 0.5 * Math.sin(t * 0.18 + m.ph);
        m.mat.opacity = m.base * (0.55 + 0.45 * k);
        const x = m.x0 + Math.sin(t * 0.05 * m.drift * 6 + m.ph) * m.drift;
        if (m.m) { m.m.position.x = x; m.m.rotation.z += m.spd * 0.016; }
        else m.sprite.position.x = x;
      }
    },
    dispose() {
      scene.remove(group);
      for (const d of disposables) { try { d.dispose(); } catch { /* abaikan */ } }
    },
  };
}
