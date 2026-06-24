/* Jungle foliage frame (side-oriented, layered, physical).
 *
 * Big leaves grow inward from each page gutter, each pivoting around its stem.
 * Several overlapping layers per side, every leaf full-colour with a hard
 * screen-space drop-shadow so overlapping shapes stay readable. Lianas hang from
 * the top corners. Nothing crosses into the content grid, and the overlay is
 * pointer-events:none so links stay clickable.
 *
 * Motion = one rAF loop per leaf:
 *   - idle: a gentle sine sway (randomised speed/phase)
 *   - scroll: each leaf is a damped torsion spring; scrolling kicks it in its own
 *     random direction, so the canopy sways freely both ways and settles (no drag/clamp)
 *   - mouse: leaves near the cursor are pushed away like wind, then spring back
 *
 * Config (optional): set window.__JUNGLE_FOLIAGE__ before this script, e.g.
 *   { contentSelector: ".md-main__inner" }   // measure margins outside this element
 *   { contentMaxWidth: 1180 }                // or assume a centred column this wide
 */
(function () {
  "use strict";

  var SCRIPT = document.currentScript;
  var BASE = new URL("foliage/", SCRIPT.src);
  var REDUCE = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var CFG = window.__JUNGLE_FOLIAGE__ || {};
  var TARGET_SEL = CFG.contentSelector || ".md-main__inner";
  var CONTENT_MAXW = CFG.contentMaxWidth || 0;

  var LEAVES = ["leaf-trio", "monstera", "big-leaf", "philodendron"];
  // intrinsic aspect (height / width) of each motif's viewBox
  var ASPECT = {
    "leaf-trio": 0.834, "monstera": 1.009, "big-leaf": 1.256,
    "philodendron": 1.068, "liana-thick": 2.315
  };

  // depth layers, back -> front. No opacity (full colour); depth = size + brightness + shadow.
  var LAYERS = [
    { count: 6, sizeFrac: 0.70, bright: 0.80, z: 1 },
    { count: 5, sizeFrac: 0.84, bright: 0.91, z: 2 },
    { count: 4, sizeFrac: 0.97, bright: 1.00, z: 3 }
  ];

  var MIN_GUTTER = 120;     // px; thinner than this and a side is skipped
  var MOUSE_R = 280;        // px radius of cursor influence
  var EDGE_PUSH = 70;       // px the stem is pushed off-screen so its cut base stays hidden
  var LEAF_SCALE = 0.7;     // overall leaf size (scales reach + push together, keeps stems hidden)
  // torsion-spring constants (degrees, seconds)
  var STIFF = 55, DAMP = 5.5, SCROLL_IMPULSE = 95, MOUSE_K = 200, MAX_SWING = 12;

  // RNG re-seeded randomly per page load → a fresh arrangement on every reload.
  // build() resets to this per-load seed so a resize keeps the same arrangement.
  var BASE_SEED = (Math.random() * 0x7fffffff) | 0;
  var seed = BASE_SEED;
  function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
  function rr(a, b) { return a + (b - a) * rnd(); }
  function pick(a) { return a[Math.floor(rnd() * a.length) % a.length]; }
  // quantised random: a multiple of `step` within +/- maxAbs (discrete buckets, no micro-jitter)
  function qStep(maxAbs, step) {
    var n = Math.round(maxAbs / step);
    return (Math.floor(rnd() * (2 * n + 1)) - n) * step;
  }

  // Worst-case INWARD horizontal extent of a motif, as a multiple of its reach,
  // over its whole sway range. Accounts for body width + base angle + max swing,
  // so we can size leaves to never cross the content edge even mid-sway.
  function maxInwardFactor(kind, aspect, dev) {
    var k = 1 / (2 * aspect);                      // half body-width / reach
    var swing = (MAX_SWING + 3) * Math.PI / 180;   // + idle headroom
    var d = dev * Math.PI / 180, m = 0;
    for (var p = d - swing; p <= d + swing + 1e-6; p += 0.04) {
      var a = Math.abs(p);
      var f = kind === "liana" ? (Math.sin(a) + k * Math.cos(a))
                               : (Math.cos(a) + k * Math.sin(a));
      if (f > m) m = f;
    }
    return m;
  }

  var root = null, items = [], raf = null;

  function addItem(o) {
    var aspect = ASPECT[o.name];
    var W = o.reach / aspect, H = o.reach;     // displayed size; reach = stem->tip length
    var pivY = (o.kind === "liana") ? 0 : 1;   // leaves pivot at bottom stem, lianas at top
    var el = document.createElement("div");
    el.className = "jf-item";
    el.style.left = (o.anchorX - W / 2) + "px";
    el.style.top = (o.anchorY - H * pivY) + "px";
    el.style.width = W + "px";
    el.style.zIndex = o.z;
    // hard, screen-space shadow (wrapper isn't rotated) + per-layer brightness for depth
    var s = o.reach;
    el.style.filter = "drop-shadow(" + (s * 0.05).toFixed(1) + "px " + (s * 0.06).toFixed(1) +
      "px " + (s * 0.012).toFixed(1) + "px rgba(0,0,0,.82)) brightness(" + o.bright + ")";

    var img = document.createElement("img");
    img.src = new URL(o.name + ".svg", BASE).href;
    img.alt = ""; img.draggable = false;
    img.style.transformOrigin = o.pivot;       // stem (leaves: bottom; lianas: top)
    img.style.transform = "rotate(" + o.baseAngle + "deg)";  // correct orientation before first frame
    el.appendChild(img);
    root.appendChild(el);

    items.push({
      img: img, kind: o.kind, base: o.baseAngle,
      ax: o.anchorX, ay: o.anchorY, reach: o.reach,
      theta: 0, omega: 0,
      idleAmp: rr(1.4, 3.0), idleSpd: rr(0.4, 0.9), phase: rr(0, 6.28),
      kick: (rnd() * 2 - 1) * (0.6 + o.bright)   // front leaves react a bit more
    });
  }

  // tip direction (unit vector, screen coords y-down) for a given render angle
  function tipDir(it, angDeg) {
    var a = angDeg * Math.PI / 180;
    return it.kind === "liana"
      ? { x: -Math.sin(a), y: Math.cos(a) }    // hangs down at angle 0
      : { x: Math.sin(a), y: -Math.cos(a) };   // points up at angle 0
  }

  function build() {
    seed = BASE_SEED;       // same arrangement across resizes within a page load
    if (root) root.remove();
    items = [];
    root = document.createElement("div");
    root.id = "jungle-foliage";
    document.body.appendChild(root);

    var vw = window.innerWidth, vh = window.innerHeight;
    var rect;
    var t = TARGET_SEL && document.querySelector(TARGET_SEL);
    if (t) { var r = t.getBoundingClientRect(); rect = { left: r.left, right: r.right }; }
    else if (CONTENT_MAXW) { var cw = Math.min(CONTENT_MAXW, vw); rect = { left: (vw - cw) / 2, right: (vw + cw) / 2 }; }
    else rect = { left: vw * 0.2, right: vw * 0.8 };

    var header = document.querySelector(".md-header");
    var headH = (header && header.offsetHeight) || 8;
    var gutterL = rect.left, gutterR = vw - rect.right;

    function leaves(isLeft) {
      var zone = isLeft ? gutterL : gutterR;
      if (zone < MIN_GUTTER) return;
      var orient = isLeft ? 90 : -90;                 // point inward
      var edge = isLeft ? 0 : vw;

      // size `desired` down until its worst-case inward extent fits the gutter
      function place(name, kind, layer, anchorX, anchorY, dev, desired) {
        var inset = isLeft ? (anchorX - edge) : (edge - anchorX);   // negative when pushed off-screen
        var budget = zone * 0.97 - inset - 8;                        // off-screen push frees inward budget
        var reach = Math.max(40, Math.min(desired, budget / (maxInwardFactor(kind, ASPECT[name], dev) + 0.05)));
        addItem({
          name: name, kind: kind, pivot: kind === "liana" ? "50% 0%" : "50% 100%",
          anchorX: anchorX, anchorY: anchorY, reach: reach,
          baseAngle: (kind === "liana" ? 0 : orient) + dev, bright: layer.bright, z: layer.z
        });
      }

      LAYERS.forEach(function (layer) {
        for (var i = 0; i < layer.count; i++) {
          var push = (EDGE_PUSH + rr(0, 80)) * LEAF_SCALE;           // hide the stem/base off-screen
          var anchorX = edge + (isLeft ? -push : push);
          var span = vh / layer.count;
          var anchorY = (i + 0.5) * span + rr(-span * 0.35, span * 0.35);
          var desired = (zone + push) * layer.sizeFrac * LEAF_SCALE * (1 + qStep(0.20, 0.10));
          place(pick(LEAVES), "leaf", layer, anchorX, anchorY, qStep(30, 10), desired);
        }
      });

      // a few lianas hanging from the top of the gutter
      var n = Math.max(1, Math.round(zone / 200));
      for (var l = 0; l < n; l++) {
        var ax = edge + (isLeft ? rr(8, zone * 0.45) : -rr(8, zone * 0.45));
        var desiredL = Math.min(vh * 0.34, zone * 1.4) * (0.7 + 0.3 * rnd());
        place("liana-thick", "liana", LAYERS[2], ax, headH - 6, qStep(16, 8), desiredL);
      }
    }

    leaves(true);
    leaves(false);
  }

  // interaction state
  var mx = -1e4, my = -1e4, lastY = window.scrollY || 0;
  var scrollAccum = 0, pendingGust = 0, scrollStopTimer = null, scrolling = false;
  window.addEventListener("mousemove", function (e) { mx = e.clientX; my = e.clientY; }, { passive: true });
  window.addEventListener("mouseout", function (e) { if (!e.relatedTarget) { mx = -1e4; my = -1e4; } });
  // Leaves are held completely still WHILE scrolling; idle/mouse/sway resume only once
  // scrolling STOPS (debounced), with a single settle-sway on the stop.
  window.addEventListener("scroll", function () {
    var y = window.scrollY || 0; scrollAccum += (y - lastY); lastY = y;
    scrolling = true;
    clearTimeout(scrollStopTimer);
    scrollStopTimer = setTimeout(function () { scrolling = false; pendingGust += scrollAccum; scrollAccum = 0; }, 140);
  }, { passive: true });

  var t0 = null, last = 0;
  function frame(ts) {
    if (t0 === null) { t0 = ts; last = ts; }
    var t = (ts - t0) / 1000;
    var dt = Math.min(0.05, Math.max(0.001, (ts - last) / 1000)); last = ts;
    // While scrolling: everything is frozen. Nothing animates until scrolling stops.
    if (scrolling) { raf = requestAnimationFrame(frame); return; }

    // settle-sway strength, applied ONCE on the frame after scrolling stops
    var gust = pendingGust ? Math.max(-1, Math.min(1, pendingGust / 300)) : 0;
    pendingGust = 0;

    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      // torsion spring: restoring + damping
      var accel = -STIFF * it.theta - DAMP * it.omega;
      it.omega += accel * dt;
      // one per-leaf directional kick the moment scrolling stops (free, multi-directional)
      if (gust) it.omega += gust * SCROLL_IMPULSE * it.kick;
      // mouse wind: push the tip away from the cursor
      if (mx > -9e3) {
        var dir = tipDir(it, it.base + it.theta);
        var ddx = (it.ax + dir.x * it.reach * 0.55) - mx, ddy = (it.ay + dir.y * it.reach * 0.55) - my;
        var d = Math.sqrt(ddx * ddx + ddy * ddy);
        if (d < MOUSE_R) {
          var f = 1 - d / MOUSE_R;
          var cross = dir.x * (my - it.ay) - dir.y * (mx - it.ax);
          it.omega += -(cross >= 0 ? 1 : -1) * f * MOUSE_K * dt;
        }
      }
      it.theta += it.omega * dt;
      if (it.theta > MAX_SWING) { it.theta = MAX_SWING; it.omega *= -0.3; }
      else if (it.theta < -MAX_SWING) { it.theta = -MAX_SWING; it.omega *= -0.3; }

      var ang = it.base + it.theta + it.idleAmp * Math.sin(t * it.idleSpd + it.phase);
      it.img.style.transform = "rotate(" + ang.toFixed(2) + "deg)";
    }
    raf = requestAnimationFrame(frame);
  }

  function start() { if (!REDUCE && raf === null) { t0 = null; raf = requestAnimationFrame(frame); } }
  function stop() { if (raf) { cancelAnimationFrame(raf); raf = null; } }

  var rt = null;
  window.addEventListener("resize", function () { clearTimeout(rt); rt = setTimeout(build, 200); }, { passive: true });
  document.addEventListener("visibilitychange", function () { document.hidden ? stop() : start(); });

  function init() {
    build();
    if (REDUCE) { for (var i = 0; i < items.length; i++) items[i].img.style.transform = "rotate(" + items[i].base + "deg)"; return; }
    start();
  }
  if (document.readyState !== "loading") init();
  else document.addEventListener("DOMContentLoaded", init);
})();
