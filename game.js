(() => {
  "use strict";

  function showFatalError(err) {
    try {
      // eslint-disable-next-line no-console
      console.error(err);
    } catch (e) {}
    try {
      const pre = document.createElement("pre");
      pre.style.position = "fixed";
      pre.style.inset = "12px";
      pre.style.padding = "12px";
      pre.style.margin = "0";
      pre.style.borderRadius = "12px";
      pre.style.background = "rgba(0,0,0,0.78)";
      pre.style.color = "rgba(255,255,255,0.92)";
      pre.style.font = "12px/1.45 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";
      pre.style.overflow = "auto";
      pre.style.zIndex = "9999";
      pre.textContent = `Game failed to load.\n\n${String(err && (err.stack || err.message || err))}`;
      document.body.appendChild(pre);
    } catch (e) {}
  }

  try {
    const canvas = document.getElementById("game");
    if (!canvas) throw new Error('Missing <canvas id="game">');
    const ctx = canvas.getContext("2d", { alpha: false }) || canvas.getContext("2d");
    if (!ctx) throw new Error("Failed to acquire 2D canvas context");

    const hudX = document.getElementById("hudX");
    const hudDecay = document.getElementById("hudDecay");
    const hudHint = document.getElementById("hudHint");
    const hudTarget = document.getElementById("hudTarget");
    const hudDebug = document.getElementById("hudDebug");

    const overlay = document.getElementById("overlay");
    const overlayTitle = document.getElementById("overlayTitle");
    const overlayBody = document.getElementById("overlayBody");
    const btnRestart = document.getElementById("btnRestart");

	  const CONFIG = {
	    initialRange: 300,
	    decayPerSecond: 0,
	    decayGraceSeconds: 1.8,
	    decayRampSeconds: 3.2,
	    decayMaxMultiplier: 2.6,
	    noMoveGraceSeconds: 1.6,
	    assistEnabled: true, // mark the correct next-step target
	    travelSpeed: 360, // world units / second
	    clickRadius: 18, // px on screen
	    minForwardDy: 72, // only allow selecting planets above current y by this amount
	    cameraFollowLerp: 0.08,
	    starCount: 220,
	    seed: 20260131,
	    zoom: 1.1,
	    zoomStart: 0.96,
	    zoomEnd: 0.88,
	    zoomRampHeight: 2200,
	    horizonOffset: 0.1, // portion of screen reserved below the world
	    sensorStart: 1200,
	    sensorEnd: 3000,
	  };

  const PlanetType = {
    DOUBLE: "增幅（×2）",
    TRIPLE: "增幅（×3）",
    NEW_EARTH: "New Earth",
    START: "Earth",
  };

  // Use a consistent visibility window for both rendering and move legality.
  // This keeps the "trap" definition aligned with what the player can actually see/select.
  function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
  }

  function dist(a, b) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return Math.hypot(dx, dy);
  }

  function formatNum(n) {
    return n.toFixed(1);
  }

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function rand() {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  function sensorRangeAtY(y, reachX = CONFIG.initialRange) {
    const sensorT = clamp(y / CONFIG.zoomRampHeight, 0, 1);
    const base = lerp(CONFIG.sensorStart, CONFIG.sensorEnd, sensorT);
    // Keep selectable/visible window large enough to include the next-step boundary even as X grows.
    const scaled = Math.max(0, reachX) * 1.12;
    return Math.max(base, scaled);
  }

  function makeBeep(frequency, durationMs, volume = 0.05) {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      const ac = new AudioCtx();
      const o = ac.createOscillator();
      const g = ac.createGain();
      o.type = "sine";
      o.frequency.value = frequency;
      g.gain.value = volume;
      o.connect(g);
      g.connect(ac.destination);
      o.start();
      setTimeout(() => {
        o.stop();
        ac.close();
      }, durationMs);
    } catch (e) {
      // ignore audio failures (autoplay policies, etc.)
    }
  }

  function planetStyle(p) {
    if (p.type === PlanetType.START) return { fill: "#3aa0ff", ring: "#9ee7ff" };
    if (p.type === PlanetType.NEW_EARTH) return { fill: "#71ffb2", ring: "#e9fff4" };
    if (p.type === PlanetType.TRIPLE) return { fill: "#ffd56b", ring: "#fff0c2" };
    return { fill: "#c7d2ff", ring: "#eef2ff" }; // DOUBLE default
  }

  function hexToRgb(hex) {
    const s = (hex || "").trim();
    if (!/^#?[0-9a-fA-F]{6}$/.test(s)) return { r: 255, g: 255, b: 255 };
    const h = s.startsWith("#") ? s.slice(1) : s;
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
    };
  }

  function mixHex(a, b, t) {
    const ca = hexToRgb(a);
    const cb = hexToRgb(b);
    const r = Math.round(lerp(ca.r, cb.r, t));
    const g = Math.round(lerp(ca.g, cb.g, t));
    const bl = Math.round(lerp(ca.b, cb.b, t));
    return `rgb(${r},${g},${bl})`;
  }

  function buildPlanetSprite(planet) {
    const style = planetStyle(planet);
    const rand = mulberry32((CONFIG.seed ^ (planet.id * 0x9e3779b9)) >>> 0);

    const scale = 2;
    const r = planet.r;
    const pad = 10;
    const size = Math.ceil((r + pad) * 2 * scale);
    const c = document.createElement("canvas");
    c.width = c.height = size;
    const g = c.getContext("2d");
    const cx = size / 2;
    const cy = size / 2;

    g.translate(cx, cy);
    g.scale(scale, scale);

    // Atmosphere / glow (earth-like).
    const hasAtmosphere = planet.type === PlanetType.START || planet.type === PlanetType.NEW_EARTH;
    if (hasAtmosphere) {
      const glow = g.createRadialGradient(-r * 0.25, -r * 0.35, r * 0.3, 0, 0, r + 10);
      glow.addColorStop(0, "rgba(158,231,255,0.18)");
      glow.addColorStop(0.6, "rgba(158,231,255,0.06)");
      glow.addColorStop(1, "rgba(158,231,255,0.0)");
      g.fillStyle = glow;
      g.beginPath();
      g.arc(0, 0, r + 10, 0, Math.PI * 2);
      g.fill();
    }

    // Sphere base shading (light from upper-left).
    const lightX = -r * 0.42;
    const lightY = -r * 0.55;
    const base = g.createRadialGradient(lightX, lightY, r * 0.2, 0, 0, r);
    base.addColorStop(0, mixHex(style.fill, "#ffffff", 0.35));
    base.addColorStop(0.55, style.fill);
    base.addColorStop(1, "rgba(0,0,0,0.78)");
    g.fillStyle = base;
    g.beginPath();
    g.arc(0, 0, r, 0, Math.PI * 2);
    g.fill();

    // Surface texture: craters / patches.
    g.save();
    g.beginPath();
    g.arc(0, 0, r, 0, Math.PI * 2);
    g.clip();

    const craterCount = planet.type === PlanetType.TRIPLE ? 13 : 9;
    for (let i = 0; i < craterCount; i++) {
      // Random point inside disk.
      let px = 0;
      let py = 0;
      for (let tries = 0; tries < 8; tries++) {
        px = (rand() * 2 - 1) * r;
        py = (rand() * 2 - 1) * r;
        if (px * px + py * py <= r * r) break;
      }
      const rr = lerp(r * 0.06, r * 0.18, rand());
      const shade = rand() * 0.18 + 0.08;

      // Shadow.
      g.fillStyle = `rgba(0,0,0,${shade})`;
      g.beginPath();
      g.arc(px + rr * 0.12, py + rr * 0.12, rr, 0, Math.PI * 2);
      g.fill();

      // Rim highlight.
      g.strokeStyle = `rgba(255,255,255,${shade * 0.65})`;
      g.lineWidth = Math.max(1, rr * 0.12);
      g.beginPath();
      g.arc(px - rr * 0.12, py - rr * 0.12, rr * 0.92, 0, Math.PI * 2);
      g.stroke();
    }

    // Bands / clouds for earth-like targets.
    if (hasAtmosphere) {
      const cloudColor = planet.type === PlanetType.NEW_EARTH ? "rgba(255,255,255,0.10)" : "rgba(255,255,255,0.08)";
      const bandCount = 5 + Math.floor(rand() * 4);
      for (let i = 0; i < bandCount; i++) {
        const y = lerp(-r * 0.75, r * 0.75, rand());
        const bandH = lerp(r * 0.08, r * 0.16, rand());
        const alpha = lerp(0.04, 0.12, rand());
        g.fillStyle = cloudColor.replace(/0\.\d+\)$/, `${alpha.toFixed(3)})`);
        g.beginPath();
        g.ellipse(lerp(-r * 0.2, r * 0.2, rand()), y, r * lerp(0.5, 0.95, rand()), bandH, lerp(-0.3, 0.3, rand()), 0, Math.PI * 2);
        g.fill();
      }
    }

    // Subtle limb (edge) highlight.
    const limb = g.createRadialGradient(lightX, lightY, r * 0.2, 0, 0, r * 1.05);
    limb.addColorStop(0.7, "rgba(255,255,255,0.0)");
    limb.addColorStop(1, "rgba(255,255,255,0.18)");
    g.strokeStyle = limb;
    g.lineWidth = 2;
    g.beginPath();
    g.arc(0, 0, r - 1, 0, Math.PI * 2);
    g.stroke();

    // Terminator darkening (night side).
    g.globalCompositeOperation = "multiply";
    const term = g.createLinearGradient(-r, -r, r, r);
    term.addColorStop(0.0, "rgba(0,0,0,0.0)");
    term.addColorStop(0.55, "rgba(0,0,0,0.0)");
    term.addColorStop(1.0, "rgba(0,0,0,0.55)");
    g.fillStyle = term;
    g.beginPath();
    g.arc(0, 0, r, 0, Math.PI * 2);
    g.fill();
    g.globalCompositeOperation = "source-over";

    g.restore();

    // Optional ring for some challenge targets.
    if (planet.type === PlanetType.CHALLENGE && rand() < 0.5) {
      g.save();
      g.translate(0, 0);
      g.rotate(lerp(-0.55, 0.55, rand()));
      g.strokeStyle = "rgba(255,255,255,0.18)";
      g.lineWidth = 2;
      g.beginPath();
      g.ellipse(0, 1, r * 1.55, r * 0.55, 0, 0, Math.PI * 2);
      g.stroke();
      g.strokeStyle = "rgba(255,255,255,0.10)";
      g.lineWidth = 5;
      g.beginPath();
      g.ellipse(0, 1, r * 1.4, r * 0.48, 0, 0, Math.PI * 2);
      g.stroke();
      g.restore();
    }

    return c;
  }

  function generatePlanets() {
    const rect = canvas.getBoundingClientRect();
    const viewW = (rect && rect.width) || 480;
    const viewH = (rect && rect.height) || 800;
    const CANDIDATE_MARGIN_PX = 18; // in CSS px

    const spineCount = 18;
    const forwardDy = CONFIG.minForwardDy == null ? 12 : CONFIG.minForwardDy;
    const worldXBound = 1e12;
    const trapClearance = 1.25;

    function clampX(x) {
      return clamp(x, -worldXBound, worldXBound);
    }

    function targetReachCssPx() {
      // Use width as the primary reference (portrait canvas).
      return Math.max(140, viewW * 0.46);
    }

    function zoomCssForReach(reach) {
      return targetReachCssPx() / Math.max(1, reach);
    }

    function computeCorrectDxWorld(originY, reach) {
      const zCss = zoomCssForReach(reach);
      const maxReachPx = Math.max(1, reach * zCss);
      // Aim for "half screen" separation, but never exceed what the current reach can support.
      const maxPxView = Math.max(60, viewW * 0.5 - CANDIDATE_MARGIN_PX);
      const targetPx = Math.min(maxPxView, maxReachPx * 0.9);
      const maxPx = Math.min(maxPxView, maxReachPx * 0.92);
      const px = clamp(targetPx, 120, maxPx);
      const dx = px / zCss;
      return clamp(dx, 80, Math.max(90, reach - 34));
    }

    function rewardMultiplier(rand) {
      // Two types only:
      // - ×2 appears twice as often as ×3 (2:1).
      return rand() < 2 / 3 ? 2 : 3;
    }

    function buildWorld(worldSeed) {
      const rand = mulberry32(worldSeed >>> 0);
      const planets = [];
      let id = 0;

      const start = {
        id: id++,
        x: 0,
        y: 0,
        r: 16,
        type: PlanetType.START,
        name: "Earth",
        mul: 1,
        explored: true,
        isSpine: true,
        spineIndex: 0,
      };
      planets.push(start);

      // Each entry represents a trap dead-zone: any *forward* planet inside `reach` breaks the trap.
      const traps = []; // {x,y,reach}

      function preservesAllTraps(pos) {
        for (const t of traps) {
          if (pos.y <= t.y + forwardDy) continue; // only forward moves matter
          const visTop = t.y + sensorRangeAtY(t.y, t.reach);
          if (pos.y > visTop) continue; // out of sight => not a selectable next move from the trap
          if (dist(pos, t) <= t.reach + trapClearance) return false;
        }
        return true;
      }

      function isForwardFrom(origin, p) {
        return p.y > origin.y + forwardDy;
      }

      function reachableFrom(origin, reach) {
        const visTop = origin.y + sensorRangeAtY(origin.y, reach);
        return planets.filter(
          (p) => !p.explored && p.y <= visTop && isForwardFrom(origin, p) && dist(origin, p) <= reach + 1e-6
        );
      }

      let cursor = { x: start.x, y: start.y };
      let reachX = CONFIG.initialRange;
      let sideHint = rand() < 0.5 ? 1 : -1;

      for (let stepIndex = 1; stepIndex <= spineCount; stepIndex++) {
        const origin = { x: cursor.x, y: cursor.y };
        const xBefore = reachX;
        const reach = Math.max(80, xBefore);

        const dxTarget = computeCorrectDxWorld(origin.y, reach);
        const zCss = zoomCssForReach(reach);
        const maxReachPx = Math.max(1, reach * zCss);
        const minHorizSepPx = Math.min(viewW * 0.5, maxReachPx * 0.78);

        let trapPlanet = null;
        let correctPlanet = null;

        for (let tries = 0; tries < 260; tries++) {
          const trapDist = clamp(reach - lerp(0.6, 1.6, rand()), 70, reach - 0.2);
          const maxTrapDx = clamp((viewW * 0.1) / Math.max(0.65, zCss), 10, 58);
          const trapDx = (rand() * 2 - 1) * maxTrapDx;
          const trapDy = Math.sqrt(Math.max(0, trapDist * trapDist - trapDx * trapDx));
          const trapPos = { x: clampX(origin.x + trapDx), y: origin.y + trapDy };
          if (!preservesAllTraps(trapPos)) continue;

          // Correct: offset left/right by ~half a screen, and keep it slightly inside the boundary.
          // Staying near the boundary keeps the universe feeling vast, but we still need enough slack for the next step.
          const correctMargin = stepIndex <= 4 ? lerp(6.0, 10.0, rand()) : lerp(10.0, 16.0, rand());
          const correctDist = clamp(reach - correctMargin, forwardDy + 120, reach - 6);
          const jitter = (rand() * 2 - 1) * 3;
          const sideOrder = [sideHint, -sideHint];
          for (const side of sideOrder) {
            const correctDx = side * (dxTarget + jitter);
            const absDx = Math.abs(correctDx);
            if (absDx >= correctDist - 18) continue;
            const correctDy = Math.sqrt(Math.max(0, correctDist * correctDist - absDx * absDx));

            // Must be a forward choice from the current origin.
            if (correctDy <= forwardDy + 18) continue;

            // Must NOT be a forward choice from the trap (geometric dead-end).
            if (correctDy > trapDy + forwardDy - 2) continue;

            // Keep both candidates in view (avoid off-screen "invisible correct planet").
            if (Math.abs(trapDx) * zCss > viewW * 0.22) continue; // stay visually centered (bias trap)
            if (Math.abs(trapDx) * zCss > viewW * 0.5 - 10) continue;
            if (Math.abs(correctDx) * zCss > viewW * 0.5 - CANDIDATE_MARGIN_PX) continue;

            // Enforce large on-screen separation (player bias trap is centered+farthest).
            const horizSepPx = Math.abs((correctDx - trapDx) * zCss);
            if (horizSepPx < minHorizSepPx) continue;

            const correctPos = { x: clampX(origin.x + correctDx), y: origin.y + correctDy };
            if (!preservesAllTraps(correctPos)) continue;

            // Ensure trap is strictly farther than correct (tempting).
            if (!(trapDist > correctDist + 0.4)) continue;

            const mul = rewardMultiplier(rand);
            trapPlanet = {
              id: id++,
              x: trapPos.x,
              y: trapPos.y,
              r: 14 + Math.floor(rand() * 6),
              type: PlanetType.TRIPLE,
              name: `信标-${stepIndex}`,
              mul: 1,
              explored: false,
              isSpine: false,
              isTrap: true,
              stepIndex,
              trapAtSpineIndex: stepIndex - 1,
              trapXBefore: xBefore,
            };
            correctPlanet = {
              id: id++,
              x: correctPos.x,
              y: correctPos.y,
              r: 13 + Math.floor(rand() * 6),
              type: mul === 3 ? PlanetType.TRIPLE : PlanetType.DOUBLE,
              name: `星球-${stepIndex}`,
              mul,
              explored: false,
              isSpine: true,
              spineIndex: stepIndex,
              stepIndex,
            };
            sideHint = side;
            break;
          }
          if (trapPlanet && correctPlanet) break;
        }

        if (!trapPlanet || !correctPlanet) return { planets: null, error: `step ${stepIndex}: failed to place trap+correct` };

        planets.push(trapPlanet);
        planets.push(correctPlanet);
        traps.push({ x: trapPlanet.x, y: trapPlanet.y, reach: xBefore });

        cursor = { x: correctPlanet.x, y: correctPlanet.y };
        reachX *= correctPlanet.mul || 1;
      }

      // New Earth: reachable from the last spine node (not constrained to start x).
      const winOrigin = { x: cursor.x, y: cursor.y };
      // Allow using (almost) full range so New Earth can sit outside the final trap's dead-zone.
      const winReach = Math.max(240, reachX - 2);
      let winPlanet = null;
      for (let tries = 0; tries < 120; tries++) {
        const zCss = zoomCssForReach(winReach);
        const dxTarget = computeCorrectDxWorld(winOrigin.y, winReach);
        const d = clamp(winReach - lerp(6, 14, rand()), 230, winReach - 2.5);
        const maxDxInView = Math.max(90, (viewW * 0.5 - CANDIDATE_MARGIN_PX) / Math.max(0.6, zCss));
        const dxAbs = clamp(dxTarget * lerp(0.8, 1.05, rand()), 110, Math.min(d - 22, maxDxInView));
        const dx = dxAbs * sideHint;
        const absDx = Math.abs(dx);
        const dy = Math.sqrt(Math.max(0, d * d - absDx * absDx));
        if (dy <= forwardDy + 28) continue;
        const pos = { x: clampX(winOrigin.x + dx), y: winOrigin.y + dy };
        if (!preservesAllTraps(pos)) continue;
        if (Math.abs(dx) * zCss > viewW * 0.5 - CANDIDATE_MARGIN_PX) continue;
        winPlanet = {
          id: id++,
          x: pos.x,
          y: pos.y,
          r: 18,
          type: PlanetType.NEW_EARTH,
          name: "New Earth",
          mul: 1,
          explored: false,
          isWin: true,
          isSpine: true,
          spineIndex: spineCount + 1,
          stepIndex: spineCount + 1,
        };
        break;
      }
      if (!winPlanet) return { planets: null, error: "failed to place New Earth" };
      planets.push(winPlanet);

      // Add extra reachable candidates for strategy (best-effort, must not invalidate traps).
      // Keep them below the current step's trap "forward horizon" so traps remain geometric dead-ends.
      function addExtraCandidates() {
        const bySpineIndex = new Map();
        for (const p of planets) {
          if (p.isSpine && typeof p.spineIndex === "number") bySpineIndex.set(p.spineIndex, p);
        }
        const trapByStep = new Map();
        for (const p of planets) {
          if (p.isTrap && typeof p.stepIndex === "number") trapByStep.set(p.stepIndex, p);
        }

        let reachBefore = CONFIG.initialRange;
        for (let stepIndex = 1; stepIndex <= spineCount; stepIndex++) {
          const origin = bySpineIndex.get(stepIndex - 1);
          const trap = trapByStep.get(stepIndex);
          const correct = bySpineIndex.get(stepIndex);
          if (!origin || !trap || !correct) return false;

          const reach = Math.max(80, reachBefore);
          const zCss = zoomCssForReach(reach);
          const dxTarget = computeCorrectDxWorld(origin.y, reach);
          const trapDx = trap.x - origin.x;
          const trapDist = dist(origin, trap);
          const trapCenter = Math.abs(trapDx);

          const minDy = forwardDy + 26;
          const maxDy = Math.min(trap.y - origin.y + forwardDy - 3, reach * 0.88);
          if (maxDy <= minDy + 8) {
            reachBefore *= correct.mul || 1;
            continue;
          }

          const side = Math.sign(correct.x - origin.x) || 1;
          const extraSide = -side; // opposite side to widen choice set

          let placed = false;
          for (let tries = 0; tries < 120; tries++) {
            const dy = lerp(minDy, maxDy, rand());
            const maxDxReach = Math.sqrt(Math.max(0, (reach - 6) * (reach - 6) - dy * dy));
            const maxDxView = Math.max(90, (viewW * 0.5 - CANDIDATE_MARGIN_PX) / Math.max(0.55, zCss));
            const maxDx = Math.min(maxDxReach, maxDxView);
            if (maxDx < 80) continue;

            const dx = extraSide * clamp(dxTarget * lerp(0.62, 0.82, rand()) + (rand() * 2 - 1) * 10, 90, maxDx - 8);
            const absDx = Math.abs(dx);
            if (absDx <= trapCenter + 14) continue; // do not out-center the trap

            const pos = { x: clampX(origin.x + dx), y: origin.y + dy };
            const d0 = Math.hypot(dx, dy);
            if (d0 >= trapDist - 6) continue; // keep trap as farthest
            if (!preservesAllTraps(pos)) continue;

            // Avoid cluttering the two main choices.
            if (dist(pos, trap) < 90) continue;
            if (dist(pos, correct) < 110) continue;

            const mul = rewardMultiplier(rand);
            planets.push({
              id: id++,
              x: pos.x,
              y: pos.y,
              r: 12 + Math.floor(rand() * 5),
              type: mul === 3 ? PlanetType.TRIPLE : PlanetType.DOUBLE,
              name: `支线-${stepIndex}`,
              mul,
              explored: false,
              isSpine: false,
              isDecoy: true,
              stepIndex,
            });
            placed = true;
            break;
          }

          // Guarantee at least one extra option at step 1 so the first decision isn't binary.
          if (!placed && stepIndex === 1) {
            const dy = clamp(reach * 0.68, minDy, maxDy);
            const maxDxReach = Math.sqrt(Math.max(0, (reach - 8) * (reach - 8) - dy * dy));
            const maxDxView = Math.max(90, (viewW * 0.5 - CANDIDATE_MARGIN_PX) / Math.max(0.55, zCss));
            const maxDx = Math.min(maxDxReach, maxDxView);
            const dx = extraSide * clamp(dxTarget * 0.72, 90, maxDx - 10);
            const pos = { x: clampX(origin.x + dx), y: origin.y + dy };
            if (Math.hypot(dx, dy) < trapDist - 10 && Math.abs(dx) > trapCenter + 18 && preservesAllTraps(pos)) {
              planets.push({
                id: id++,
                x: pos.x,
                y: pos.y,
                r: 14,
                type: PlanetType.DOUBLE,
                name: "支线-1",
                mul: 2,
                explored: false,
                isSpine: false,
                isDecoy: true,
                stepIndex: 1,
              });
            }
          }

          reachBefore *= correct.mul || 1;
        }
        return true;
      }

      addExtraCandidates();

      // Validate: every step offers trap+correct, and picking any trap immediately dead-ends.
      function validate() {
        const bySpineIndex = new Map();
        for (const p of planets) {
          if (p.isSpine && typeof p.spineIndex === "number") bySpineIndex.set(p.spineIndex, p);
        }
        let simCursor = bySpineIndex.get(0);
        if (!simCursor) return false;
        let simReach = CONFIG.initialRange;
        const win = planets.find((p) => p.isWin);
        if (!win) return false;

        for (let stepIndex = 1; stepIndex <= spineCount; stepIndex++) {
          const trap = planets.find((p) => p.isTrap && p.stepIndex === stepIndex);
          const correct = bySpineIndex.get(stepIndex);
          if (!trap || !correct) return false;

          // From the current node, both must be reachable and "trap" must be the tempting centered+farthest.
          const candidates = reachableFrom(simCursor, simReach);
          if (stepIndex === 1 && candidates.length < 3) return false;
          if (stepIndex < spineCount && candidates.some((p) => p.id === win.id)) return false;
          if (!candidates.some((p) => p.id === trap.id)) return false;
          if (!candidates.some((p) => p.id === correct.id)) return false;
          const trapDist = dist(simCursor, trap);
          for (const c of candidates) {
            if (c.id === trap.id) continue;
            if (dist(simCursor, c) > trapDist + 1e-6) return false;
          }
          const trapCenter = Math.abs(trap.x - simCursor.x);
          let minCenter = Infinity;
          for (const c of candidates) minCenter = Math.min(minCenter, Math.abs(c.x - simCursor.x));
          if (trapCenter > minCenter + 1e-6) return false;

          // If player picks the trap, it must dead-end for the *next step* (matches runtime step gating).
          const trapNextStep = stepIndex + 1;
          const trapReachableNext = reachableFrom(trap, simReach).filter(
            (p) => typeof p.stepIndex !== "number" || p.stepIndex === trapNextStep
          );
          if (trapReachableNext.length !== 0) return false;

          // Follow the success route.
          simCursor = correct;
          simReach *= correct.mul || 1;
        }

        // Winning planet must be reachable from the last correct.
        if (!reachableFrom(simCursor, simReach).some((p) => p.id === win.id)) return false;
        return true;
      }

      if (!validate()) return { planets: null, error: "validation failed" };

      planets.sort((a, b) => a.y - b.y);
      return { planets, error: null };
    }

    let lastError = null;
    for (let attempt = 0; attempt < 120; attempt++) {
      const result = buildWorld((CONFIG.seed ^ 0x85ebca6b ^ (attempt * 0x9e3779b9)) >>> 0);
      if (result && result.planets) return result.planets;
      lastError = (result && result.error) || lastError;
    }
    try {
      window.__EARTH_ASCENT_LAST_GEN_ERROR__ = lastError;
    } catch (e) {}

    // Last-ditch fallback: single trap + a reachable win (still playable, but should be extremely rare).
    const planets = [];
    let id = 0;
    planets.push({
      id: id++,
      x: 0,
      y: 0,
      r: 16,
      type: PlanetType.START,
      name: "Earth",
      mul: 1,
      explored: true,
      isSpine: true,
      spineIndex: 0,
    });
    planets.push({
      id: id++,
      x: 0,
      y: CONFIG.initialRange - 1,
      r: 16,
      type: PlanetType.TRIPLE,
      name: "信标-1",
      mul: 1,
      explored: false,
      isTrap: true,
      stepIndex: 1,
    });
    planets.push({
      id: id++,
      x: 110,
      y: Math.max(90, CONFIG.initialRange - 30),
      r: 16,
      type: PlanetType.NEW_EARTH,
      name: "New Earth",
      mul: 1,
      explored: false,
      isWin: true,
      isSpine: true,
      spineIndex: 1,
      stepIndex: 1,
    });
    return planets;
  }

  function generateStars(w, h) {
    const rand = mulberry32(CONFIG.seed ^ 0x9e3779b9);
    const stars = [];
    for (let i = 0; i < CONFIG.starCount; i++) {
      stars.push({
        x: rand() * w,
        y: rand() * h,
        r: rand() * 1.3 + 0.2,
        a: rand() * 0.65 + 0.15,
      });
    }
    return stars;
  }

  function setOverlay(visible, title, body) {
    overlay.classList.toggle("overlay--hidden", !visible);
    overlayTitle.textContent = title == null ? "" : title;
    overlayBody.textContent = body == null ? "" : body;
  }

  function worldToScreen(world, cam, w, h) {
    const z = cam.zoom || 1;
    const sx = (world.x - cam.x) * z + w / 2;
    const off = typeof CONFIG.horizonOffset === "number" ? CONFIG.horizonOffset : 0.18;
    const sy = h - (world.y - cam.y) * z - h * off;
    return { x: sx, y: sy };
  }

  function screenToWorld(screen, cam, w, h) {
    const z = cam.zoom || 1;
    const wx = (screen.x - w / 2) / z + cam.x;
    const off = typeof CONFIG.horizonOffset === "number" ? CONFIG.horizonOffset : 0.18;
    const wy = ((h - h * off - screen.y) / z) + cam.y;
    return { x: wx, y: wy };
  }

  function resizeCanvas() {
    // Keep internal resolution stable-ish, but match DPR for crispness.
    const rect = canvas.getBoundingClientRect();
    const dpr = clamp(window.devicePixelRatio || 1, 1, 2);
    const targetW = Math.floor(rect.width * dpr);
    const targetH = Math.floor((rect.width * (5 / 3)) * dpr); // portrait
    canvas.width = clamp(targetW, 360, 1600);
    canvas.height = clamp(targetH, 600, 2600);
  }

  function currentDpr() {
    const rect = canvas.getBoundingClientRect();
    const cssW = rect && rect.width ? rect.width : canvas.width || 1;
    const dpr = (canvas.width || 1) / Math.max(1, cssW);
    return clamp(dpr, 1, 3);
  }

  function createGame() {
    const DEBUG_UI = /\bdebug=1\b/.test(String(window.location && window.location.search));
    const ASSIST_QUERY = (() => {
      try {
        const s = String(window.location && window.location.search);
        if (/\bassist=0\b/.test(s)) return false;
        if (/\bassist=1\b/.test(s)) return true;
      } catch (e) {}
      return null;
    })();
    resizeCanvas();
    let planets = generatePlanets();
    let currentPlanet = planets.find((p) => p.type === PlanetType.START) || planets[0];
    let rangeX = CONFIG.initialRange;
    let worldMaxSpineIndex = Math.max(0, ...planets.map((p) => (typeof p.spineIndex === "number" ? p.spineIndex : 0)));
    let timeSinceArrive = 0;
    let assistEnabled = ASSIST_QUERY == null ? !!CONFIG.assistEnabled : !!ASSIST_QUERY;

    const dpr = currentDpr();
    let camera = { x: currentPlanet.x, y: currentPlanet.y, zoom: CONFIG.zoomStart * dpr };
    let rocket = {
      x: currentPlanet.x,
      y: currentPlanet.y,
      vx: 0,
      vy: 0,
      traveling: false,
      targetId: null,
    };

    let selectedId = null;
    let isGameOver = false;
    let isWin = false;

    let lastTs = performance.now();
    let stars = generateStars(canvas.width, canvas.height);
    let idleTimeSeconds = 0;
    let lastEffectiveDecay = CONFIG.decayPerSecond;
    let decayWarningArmed = true;
    const planetSprites = new Map();
    let rocketSprite = null;
    function currentStepIndex() {
      if (currentPlanet && typeof currentPlanet.spineIndex === "number") return currentPlanet.spineIndex;
      if (currentPlanet && typeof currentPlanet.stepIndex === "number") return currentPlanet.stepIndex;
      return 0;
    }

    function nextStepIndex() {
      return currentStepIndex() + 1;
    }

    function toggleAssist() {
      assistEnabled = !assistEnabled;
      makeBeep(assistEnabled ? 660 : 220, 70, 0.03);
    }

    function isSolutionTarget(p) {
      if (!assistEnabled) return false;
      const next = nextStepIndex();
      if (p.explored) return false;
      if (typeof p.stepIndex === "number" && p.stepIndex !== next) return false;
      if (typeof p.spineIndex === "number") return p.spineIndex === next;
      return !!p.isWin && next === worldMaxSpineIndex;
    }

    function reset() {
      resizeCanvas();
      planets = generatePlanets();
      currentPlanet = planets.find((p) => p.type === PlanetType.START) || planets[0];
      rangeX = CONFIG.initialRange;
      worldMaxSpineIndex = Math.max(0, ...planets.map((p) => (typeof p.spineIndex === "number" ? p.spineIndex : 0)));
      timeSinceArrive = 0;
      assistEnabled = ASSIST_QUERY == null ? !!CONFIG.assistEnabled : !!ASSIST_QUERY;
      const dpr = currentDpr();
      camera = { x: currentPlanet.x, y: currentPlanet.y, zoom: CONFIG.zoomStart * dpr };
      rocket = { x: currentPlanet.x, y: currentPlanet.y, vx: 0, vy: 0, traveling: false, targetId: null };
      selectedId = null;
      isGameOver = false;
      isWin = false;
      lastTs = performance.now();
      stars = generateStars(canvas.width, canvas.height);
      idleTimeSeconds = 0;
      lastEffectiveDecay = CONFIG.decayPerSecond;
      decayWarningArmed = true;
      planetSprites.clear();
      rocketSprite = null;
      setOverlay(false);
      makeBeep(520, 80, 0.03);
    }

    function spriteFor(planet) {
      const cached = planetSprites.get(planet.id);
      if (cached) return cached;
      const sprite = buildPlanetSprite(planet);
      planetSprites.set(planet.id, sprite);
      return sprite;
    }

    function rewardText(p) {
      const mul = typeof p.mul === "number" ? p.mul : 1;
      if (p.isTrap) return "奖励：—";
      if (p.isWin) return "奖励：通关";
      if (mul === 2) return "奖励：×2";
      if (mul === 3) return "奖励：×3";
      return "奖励：—";
    }

	    function getPlanetById(id) {
	      return planets.find((p) => p.id === id) || null;
	    }

	    function isForwardFromCurrent(p) {
	      return p.y > currentPlanet.y + (CONFIG.minForwardDy || 0);
	    }

	    function reachablePlanets() {
	      const visTop = currentPlanet.y + sensorRangeAtY(currentPlanet.y, rangeX);
	      const nextStep = nextStepIndex();
	      return planets.filter(
	        (p) =>
	          !p.explored &&
	          (typeof p.stepIndex !== "number" || p.stepIndex === nextStep) &&
	          p.y <= visTop &&
	          isForwardFromCurrent(p) &&
	          dist(p, currentPlanet) <= rangeX + 1e-6
	      );
	    }

    function computeReachableCount() {
      return reachablePlanets().length;
    }

    function updateHud() {
      hudX.textContent = `${formatNum(rangeX)}`;
      const idleDecay = !rocket.traveling && !isGameOver && !isWin;
      if (!idleDecay) {
        hudDecay.textContent = "暂停";
      } else {
        hudDecay.textContent = `衰减中（-${lastEffectiveDecay.toFixed(1)}/s）`;
      }

      const stepIndex =
        typeof currentPlanet.spineIndex === "number"
          ? currentPlanet.spineIndex
          : typeof currentPlanet.stepIndex === "number"
            ? currentPlanet.stepIndex
            : 0;

      const sel = selectedId != null ? getPlanetById(selectedId) : null;
      if (!sel) {
        hudTarget.textContent = `进度：${stepIndex}/${worldMaxSpineIndex} · 目标：—`;
      } else {
        const d = dist(sel, currentPlanet);
        hudTarget.textContent = `进度：${stepIndex}/${worldMaxSpineIndex} · 目标：${sel.name}（${sel.type}，${rewardText(sel)}，距离=${formatNum(d)}）`;
      }

      if (isGameOver) return;
      if (isWin) return;

	      if (rocket.traveling) {
	        hudHint.textContent = "飞行中…";
	      } else {
	        const reachable = computeReachableCount();
        if (reachable === 0) {
          const grace = CONFIG.noMoveGraceSeconds || 0;
          const left = clamp(grace - timeSinceArrive, 0, 99);
          hudHint.textContent = `无可达目标（${left.toFixed(1)}s 后判定停滞）：这是几何上的死局。`;
        } else {
          hudHint.textContent = assistEnabled
            ? "引导已开启：已标记正确解法（按 H 关闭）。星球只有两种奖励：×2 / ×3（×2 频率更高）。"
            : "用范围扇形判断可达：星球只有两种奖励：×2 / ×3（×2 频率更高）。按 H 开启引导。";
        }
      }

      if (hudDebug) {
        hudDebug.classList.toggle("hud__debug--hidden", !DEBUG_UI);
        if (DEBUG_UI) {
          const lastErr = (() => {
            try {
              return window.__EARTH_ASCENT_LAST_GEN_ERROR__ || null;
            } catch (e) {
              return null;
            }
          })();
          const reachable = reachablePlanets();
          const step = currentStepIndex();
          const nextStep = nextStepIndex();
          const names = reachable
            .slice()
            .sort((a, b) => dist(a, currentPlanet) - dist(b, currentPlanet))
            .map((p) => (p.isWin ? "WIN:" : p.isTrap ? "TRAP:" : "") + p.name)
            .join(", ");
          const lastErrText = lastErr == null ? "null" : String(lastErr);
          hudDebug.textContent = `debug=1 · seed=${CONFIG.seed} · planets=${planets.length} · step=${step}->${nextStep} · reachable=${reachable.length} · lastGenError=${lastErrText} · ${names}`;
        }
      }
	    }

    function endGame(kind) {
      if (isGameOver || isWin) return;
      if (kind === "win") {
        isWin = true;
        setOverlay(
          true,
          "通关：New Earth",
          "只要探索的意志仍在，人类终将跨越看似不可能的距离。"
        );
        makeBeep(740, 120, 0.045);
        setTimeout(() => makeBeep(980, 120, 0.04), 140);
        return;
      }

      isGameOver = true;
      setOverlay(
        true,
        "探索停滞",
        "宇宙太大，而我们的热情太少。\n\n人类并非无法探索宇宙，而是在漫长的时间尺度中，探索意志衰退得太快。"
      );
      makeBeep(180, 220, 0.05);
    }

    function trySelectPlanetAtScreenPoint(sx, sy) {
      if (isGameOver || isWin) return;
      if (rocket.traveling) return;
      const w = canvas.width;
      const h = canvas.height;
      const click = { x: sx, y: sy };
      const visTop = currentPlanet.y + sensorRangeAtY(currentPlanet.y, rangeX);
      const nextStep = nextStepIndex();

	      let best = null;
	      let bestD = Infinity;
	      for (const p of planets) {
	        if (p.explored) continue;
	        if (typeof p.stepIndex === "number" && p.stepIndex !== nextStep) continue;
	        if (p.y > visTop) continue;
	        if (!isForwardFromCurrent(p)) continue;
	        const sp = worldToScreen(p, camera, w, h);
	        const d = Math.hypot(sp.x - click.x, sp.y - click.y);
	        if (d <= CONFIG.clickRadius && d < bestD) {
	          best = p;
	          bestD = d;
	        }
      }

	      selectedId = best ? best.id : null;
	      if (!best) return;

	      const reachable =
	        (typeof best.stepIndex !== "number" || best.stepIndex === nextStep) &&
	        isForwardFromCurrent(best) &&
	        dist(best, currentPlanet) <= rangeX + 1e-6;
	      if (!reachable) {
	        makeBeep(220, 60, 0.03);
	        return;
	      }
	      beginTravelTo(best);
    }

    function beginTravelTo(targetPlanet) {
      rocket.traveling = true;
      rocket.targetId = targetPlanet.id;
      idleTimeSeconds = 0;
      decayWarningArmed = true;
      timeSinceArrive = 0;

      const d = dist(targetPlanet, rocket);
      if (d < 1e-6) {
        arriveAt(targetPlanet);
        return;
      }

      rocket.vx = ((targetPlanet.x - rocket.x) / d) * CONFIG.travelSpeed;
      rocket.vy = ((targetPlanet.y - rocket.y) / d) * CONFIG.travelSpeed;
      makeBeep(520, 70, 0.03);
    }

	    function arriveAt(targetPlanet) {
	      rocket.traveling = false;
	      rocket.targetId = null;
      rocket.vx = 0;
      rocket.vy = 0;
      rocket.x = targetPlanet.x;
      rocket.y = targetPlanet.y;
      idleTimeSeconds = 0;
      decayWarningArmed = true;
      timeSinceArrive = 0;

      targetPlanet.explored = true;
      currentPlanet = targetPlanet;
      selectedId = null;

      if (targetPlanet.isWin) {
        endGame("win");
        return;
      }

	      const mul = typeof targetPlanet.mul === "number" ? targetPlanet.mul : 1;
	      rangeX = clamp(rangeX * Math.max(0, mul), 0, 999999999999);
	      makeBeep(860, 90, 0.04);
	    }

    function update(dt) {
      if (isGameOver || isWin) {
        updateHud();
        return;
      }

      if (!rocket.traveling) {
        timeSinceArrive += dt;
      }

      // Decay only while idle (not traveling).
      if (!rocket.traveling) {
        idleTimeSeconds += dt;
        const grace = CONFIG.decayGraceSeconds;
        const ramp = CONFIG.decayRampSeconds;
        const t = ramp <= 1e-6 ? 1 : clamp((idleTimeSeconds - grace) / ramp, 0, 1);
        const mult = 1 + t * (CONFIG.decayMaxMultiplier - 1);
        lastEffectiveDecay = CONFIG.decayPerSecond * mult;
        rangeX = clamp(rangeX - lastEffectiveDecay * dt, 0, 99999);

        if (decayWarningArmed && idleTimeSeconds >= grace) {
          decayWarningArmed = false;
          makeBeep(330, 70, 0.025);
        }
      } else {
        idleTimeSeconds = 0;
        decayWarningArmed = true;
        lastEffectiveDecay = CONFIG.decayPerSecond;
      }

      // Travel.
      if (rocket.traveling) {
        const target = getPlanetById(rocket.targetId);
        if (!target) {
          rocket.traveling = false;
          rocket.targetId = null;
        } else {
          rocket.x += rocket.vx * dt;
          rocket.y += rocket.vy * dt;
          const remaining = dist(target, rocket);
          if (remaining <= CONFIG.travelSpeed * dt * 0.85) {
            arriveAt(target);
          }
        }
      }

      // Fail state: no reachable un-explored planets (when idle).
      if (!rocket.traveling && computeReachableCount() === 0) {
        const grace = CONFIG.noMoveGraceSeconds || 0;
        if (timeSinceArrive >= grace) endGame("lose");
      }

      // Camera follow rocket smoothly.
      camera.x = lerp(camera.x, rocket.x, CONFIG.cameraFollowLerp);
      camera.y = lerp(camera.y, rocket.y, CONFIG.cameraFollowLerp);
      // Dynamic zoom: keep the reach arc readable even when X grows (multipliers).
      const reachPxTarget = Math.max(120, canvas.width * 0.46);
      const targetZoom = reachPxTarget / Math.max(1, rangeX);
      camera.zoom = lerp(camera.zoom, targetZoom, 0.08);

      updateHud();
    }

    function buildRocketSprite() {
      const scale = 2;
      const size = 96 * scale;
      const c = document.createElement("canvas");
      c.width = c.height = size;
      const g = c.getContext("2d");
      const cx = size / 2;
      const cy = size / 2;

      g.translate(cx, cy);
      g.scale(scale, scale);

      // Drop shadow.
      g.save();
      g.globalAlpha = 0.22;
      g.fillStyle = "black";
      g.beginPath();
      g.ellipse(2, 18, 10, 6, 0, 0, Math.PI * 2);
      g.fill();
      g.restore();

      // Body with gradient (metallic).
      const bodyGrad = g.createLinearGradient(-10, -22, 12, 20);
      bodyGrad.addColorStop(0, "rgba(255,255,255,0.95)");
      bodyGrad.addColorStop(0.45, "rgba(225,230,240,0.92)");
      bodyGrad.addColorStop(1, "rgba(160,170,190,0.92)");
      g.fillStyle = bodyGrad;

      g.beginPath();
      g.moveTo(0, -26);
      g.bezierCurveTo(10, -18, 12, -4, 12, 12);
      g.quadraticCurveTo(12, 18, 0, 22);
      g.quadraticCurveTo(-12, 18, -12, 12);
      g.bezierCurveTo(-12, -4, -10, -18, 0, -26);
      g.closePath();
      g.fill();

      // Nose highlight.
      g.strokeStyle = "rgba(255,255,255,0.35)";
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(-3, -22);
      g.quadraticCurveTo(0, -26, 3, -22);
      g.stroke();

      // Window.
      const wGrad = g.createRadialGradient(-3, -6, 1, 0, -5, 7);
      wGrad.addColorStop(0, "rgba(170,245,255,0.9)");
      wGrad.addColorStop(1, "rgba(40,140,190,0.65)");
      g.fillStyle = wGrad;
      g.beginPath();
      g.arc(0, -6, 6, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = "rgba(255,255,255,0.35)";
      g.lineWidth = 1.5;
      g.stroke();

      // Fins.
      g.fillStyle = "rgba(210,215,230,0.9)";
      g.beginPath();
      g.moveTo(-12, 10);
      g.lineTo(-22, 22);
      g.lineTo(-10, 20);
      g.closePath();
      g.fill();
      g.beginPath();
      g.moveTo(12, 10);
      g.lineTo(22, 22);
      g.lineTo(10, 20);
      g.closePath();
      g.fill();

      // Engine bell.
      g.fillStyle = "rgba(120,130,150,0.9)";
      g.beginPath();
      g.ellipse(0, 20, 8, 5, 0, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = "rgba(255,255,255,0.18)";
      g.lineWidth = 1;
      g.stroke();

      return c;
    }

    function drawBeaconOverlay(x, y, z) {
      const t = performance.now() / 1000;
      const pulse = 0.5 + 0.5 * Math.sin(t * 2.6);
      const r = (16 + 6 * pulse) * z;

      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = 0.22 + 0.12 * pulse;
      ctx.strokeStyle = "rgba(255,245,200,0.9)";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 7]);
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);

      // Tiny sparkle (attractive, not a "danger" cue).
      ctx.globalAlpha = 0.25 + 0.25 * pulse;
      ctx.strokeStyle = "rgba(255,255,255,0.9)";
      ctx.lineWidth = 1.25;
      const s = (7 + 3 * pulse) * z;
      ctx.beginPath();
      ctx.moveTo(x - s, y);
      ctx.lineTo(x + s, y);
      ctx.moveTo(x, y - s);
      ctx.lineTo(x, y + s);
      ctx.stroke();
      ctx.restore();
    }

    function drawAssistOverlay(x, y, z) {
      const t = performance.now() / 1000;
      const pulse = 0.5 + 0.5 * Math.sin(t * 2.2);
      const r = (18 + 7 * pulse) * z;

      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = 0.16 + 0.14 * pulse;
      ctx.strokeStyle = "rgba(120,255,180,0.92)";
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 7]);
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);

      // Small upward chevron marker.
      ctx.globalAlpha = 0.2 + 0.18 * pulse;
      ctx.fillStyle = "rgba(200,255,230,0.85)";
      const s = (8 + 3 * pulse) * z;
      ctx.beginPath();
      ctx.moveTo(x, y - r - s * 1.6);
      ctx.lineTo(x - s, y - r - s * 0.6);
      ctx.lineTo(x + s, y - r - s * 0.6);
      ctx.closePath();
      ctx.fill();

      ctx.restore();
    }

    function draw() {
      const w = canvas.width;
      const h = canvas.height;

      // Background.
      ctx.fillStyle = "#070a12";
      ctx.fillRect(0, 0, w, h);

      // Stars (screen-space, slight parallax based on camera).
      const par = 0.04;
      for (const s of stars) {
        const x = (s.x - camera.x * par + w) % w;
        const y = (s.y + camera.y * par + h) % h;
        ctx.fillStyle = `rgba(255,255,255,${s.a})`;
        ctx.beginPath();
        ctx.arc(x, y, s.r, 0, Math.PI * 2);
        ctx.fill();
      }

      // Reachable range shown as a semicircle "fan" (only when idle).
      if (!rocket.traveling && !isGameOver && !isWin) {
        const cp = worldToScreen(currentPlanet, camera, w, h);
        const z = camera.zoom || 1;
        const rr = rangeX * z;
        ctx.save();

        // Soft fill: draw a full radial gradient circle then mask to a *feathered* upper half,
        // so the "diameter" edge isn't a sharp cutoff.
        const fill = ctx.createRadialGradient(cp.x, cp.y, 0, cp.x, cp.y, rr);
        fill.addColorStop(0, "rgba(158,231,255,0.14)");
        fill.addColorStop(1, "rgba(158,231,255,0.00)");
        ctx.fillStyle = fill;
        ctx.beginPath();
        ctx.arc(cp.x, cp.y, rr, 0, Math.PI * 2);
        ctx.fill();

        ctx.globalCompositeOperation = "destination-in";
        const feather = Math.max(22, rr * 0.09);
        const mask = ctx.createLinearGradient(0, cp.y - rr, 0, cp.y + feather);
        const centerStop = rr / (rr + feather);
        mask.addColorStop(0, "rgba(0,0,0,1)");
        mask.addColorStop(centerStop, "rgba(0,0,0,1)");
        mask.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = mask;
        ctx.fillRect(0, 0, w, h);

        ctx.globalCompositeOperation = "source-over";

        // Boundary for clearer readability.
        ctx.strokeStyle = "rgba(158,231,255,0.55)";
        ctx.lineWidth = 2;
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.arc(cp.x, cp.y, rr, Math.PI, Math.PI * 2);
        ctx.stroke();

        ctx.strokeStyle = "rgba(158,231,255,0.8)";
        ctx.lineWidth = 1.25;
        ctx.setLineDash([7, 8]);
        ctx.beginPath();
        ctx.arc(cp.x, cp.y, rr, Math.PI, Math.PI * 2);
        ctx.stroke();

        ctx.restore();
      }

      // Planets.
      const sensorRange = sensorRangeAtY(currentPlanet.y, rangeX);
      for (const p of planets) {
        if (p.y < currentPlanet.y - 260) continue;
        if (p.y > currentPlanet.y + sensorRange) continue;
        const sp = worldToScreen(p, camera, w, h);
        const inView = sp.x > -60 && sp.x < w + 60 && sp.y > -80 && sp.y < h + 80;
        if (!inView) continue;

        const style = planetStyle(p);
        const isCurrent = p.id === currentPlanet.id;
        const alpha = isCurrent ? 0.9 : p.explored ? 0.22 : 0.55;
        const ringAlpha = isCurrent ? 0.22 : p.explored ? 0.08 : 0.1;

        const sprite = spriteFor(p);
        const z = camera.zoom || 1;
        // Keep a minimum on-screen size for readability even when zooming out a lot.
        const minPx = 26;
        const drawZ = Math.max(z, minPx / Math.max(1, sprite.width));
        const sw = sprite.width * drawZ;
        const sh = sprite.height * drawZ;
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.drawImage(sprite, sp.x - sw / 2, sp.y - sh / 2, sw, sh);
        ctx.restore();

        // Subtle outline (kept minimal, not a "reachable highlight").
        ctx.save();
        ctx.globalAlpha = ringAlpha;
        ctx.strokeStyle = style.ring;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(sp.x, sp.y, (p.r + 1.5) * drawZ, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();

        // Selected ring.
        if (selectedId === p.id && !p.explored) {
          ctx.save();
          ctx.strokeStyle = "#9ee7ff";
          ctx.globalAlpha = 0.9;
          ctx.lineWidth = 2.5;
          ctx.beginPath();
          ctx.arc(sp.x, sp.y, (p.r + 10) * drawZ, 0, Math.PI * 2);
          ctx.stroke();
          ctx.restore();
        }

        if (p.isTrap && !p.explored) {
          drawBeaconOverlay(sp.x, sp.y, drawZ);
        }

        if (isSolutionTarget(p)) {
          drawAssistOverlay(sp.x, sp.y, drawZ);
        }
      }

      // Rocket.
      const rp = worldToScreen(rocket, camera, w, h);
      if (!rocketSprite) rocketSprite = buildRocketSprite();
      const z = camera.zoom || 1;
      const angle = rocket.traveling && (Math.abs(rocket.vx) + Math.abs(rocket.vy) > 1e-6)
        ? Math.atan2(-rocket.vy, rocket.vx) + Math.PI / 2
        : 0;
      const minRocketPx = 54;
      const rocketZoom = Math.max(z, minRocketPx / 96);
      drawRocket(rp.x, rp.y, rocket.traveling, angle, rocketZoom);
    }

    function drawRocket(x, y, thrust, angle, zoom) {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(angle);
      ctx.scale(zoom, zoom);

      if (thrust) {
        const t = performance.now() / 1000;
        const flick = 0.7 + 0.3 * Math.sin(t * 22);
        ctx.save();
        ctx.globalCompositeOperation = "lighter";
        ctx.globalAlpha = 0.75 * flick;
        const flame = ctx.createLinearGradient(0, 22, 0, 50);
        flame.addColorStop(0, "rgba(255,220,160,0.0)");
        flame.addColorStop(0.25, "rgba(255,220,160,0.25)");
        flame.addColorStop(0.55, "rgba(158,231,255,0.55)");
        flame.addColorStop(1, "rgba(120,190,255,0.0)");
        ctx.fillStyle = flame;
        ctx.beginPath();
        ctx.moveTo(-6, 22);
        ctx.quadraticCurveTo(0, 50, 6, 22);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }

      ctx.globalAlpha = 1;
      ctx.drawImage(rocketSprite, -rocketSprite.width / 4, -rocketSprite.height / 4, rocketSprite.width / 2, rocketSprite.height / 2);

      ctx.restore();
    }

    function frame(ts) {
      const dt = clamp((ts - lastTs) / 1000, 0, 0.05);
      lastTs = ts;
      update(dt);
      draw();
      requestAnimationFrame(frame);
    }

    function onPointer(e) {
      const rect = canvas.getBoundingClientRect();
      const dpr = canvas.width / rect.width;
      const sx = (e.clientX - rect.left) * dpr;
      const sy = (e.clientY - rect.top) * dpr;
      trySelectPlanetAtScreenPoint(sx, sy);
    }

    function onKeyDown(e) {
      const key = String(e && e.key || "");
      if (key === "h" || key === "H") {
        toggleAssist();
        updateHud();
        e.preventDefault();
      }
    }

    function onResize() {
      resizeCanvas();
      stars = generateStars(canvas.width, canvas.height);
    }

    btnRestart.addEventListener("click", () => reset());
    canvas.addEventListener("pointerdown", onPointer);
    window.addEventListener("resize", onResize);
    window.addEventListener("keydown", onKeyDown, { passive: false });

    onResize();
    setOverlay(false);
    updateHud();
    requestAnimationFrame(frame);

    function debugSnapshot() {
      const w = canvas.width;
      const h = canvas.height;
      const reachable = reachablePlanets();
      const reachableInfo = reachable.map((p) => {
        const sp = worldToScreen(p, camera, w, h);
        return {
          id: p.id,
          name: p.name,
          type: p.type,
          isTrap: !!p.isTrap,
          isWin: !!p.isWin,
          isSpine: !!p.isSpine,
          spineIndex: typeof p.spineIndex === "number" ? p.spineIndex : null,
          stepIndex: typeof p.stepIndex === "number" ? p.stepIndex : null,
          x: p.x,
          y: p.y,
          sx: sp.x,
          sy: sp.y,
          d: dist(p, currentPlanet),
          mul: typeof p.mul === "number" ? p.mul : 1,
        };
      });

      const curSpine =
        typeof currentPlanet.spineIndex === "number"
          ? currentPlanet.spineIndex
          : typeof currentPlanet.stepIndex === "number"
            ? currentPlanet.stepIndex
            : 0;
      const nextSpine = curSpine + 1;

      const trap =
        reachableInfo.find((p) => p.isTrap && p.stepIndex === nextSpine) ||
        reachableInfo.find((p) => p.isTrap) ||
        null;
      const correct =
        reachableInfo.find((p) => p.isSpine && p.spineIndex === nextSpine) ||
        reachableInfo.find((p) => !p.isTrap && !p.isWin) ||
        null;
      const win = reachableInfo.find((p) => p.isWin) || null;

      return {
        canvas: { w, h },
        rangeX,
        currentPlanetId: currentPlanet && currentPlanet.id,
        rocket: { x: rocket.x, y: rocket.y, traveling: rocket.traveling, targetId: rocket.targetId },
        camera: { x: camera.x, y: camera.y, zoom: camera.zoom },
        planetCount: planets.length,
        planets: planets.map((p) => ({
          id: p.id,
          name: p.name,
          type: p.type,
          x: p.x,
          y: p.y,
          mul: typeof p.mul === "number" ? p.mul : 1,
          explored: !!p.explored,
          isTrap: !!p.isTrap,
          isWin: !!p.isWin,
          isSpine: !!p.isSpine,
          spineIndex: typeof p.spineIndex === "number" ? p.spineIndex : null,
          stepIndex: typeof p.stepIndex === "number" ? p.stepIndex : null,
        })),
        reachable: reachableInfo,
        trap,
        correct,
        win,
        isGameOver,
        isWin,
      };
    }

    return { reset, debugSnapshot };
  }

    const game = createGame();
    // Expose for quick debugging in console.
    window.__EARTH_ASCENT__ = game;
  } catch (err) {
    window.__EARTH_ASCENT_ERROR__ = err;
    showFatalError(err);
  }
})();
