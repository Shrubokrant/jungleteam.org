/* Jungle foliage frame (side-oriented, layered, physical).
 *
 * Big leaves grow inward from each page gutter, each pivoting around its stem.
 * Several overlapping layers per side, every leaf full-colour with a hard
 * screen-space drop-shadow so overlapping shapes stay readable. Lianas hang from
 * the top corners. Nothing crosses into the content grid, and the overlay is
 * pointer-events:none so links stay clickable.
 *
 * Motion = one rAF loop per leaf:
 *   - idle: a gentle slow sine sway (randomised speed/phase)
 *   - scroll: scroll activity (0..1, fades when you stop) boosts that sine's amplitude, so
 *     leaves sway softly back and forth while scrolling — never pinned at a limit
 *   - mouse: leaves near the cursor are pushed away like wind (damped spring), then settle back
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

  // overridable per page via window.__JUNGLE_FOLIAGE__ (defaults tuned for the wide docs gutters)
  var MIN_GUTTER = CFG.minGutter != null ? CFG.minGutter : 120;  // px; thinner side is skipped
  var MOUSE_R = 280;        // px radius of cursor influence
  var EDGE_PUSH = CFG.edgePush != null ? CFG.edgePush : 70;       // px the stem is pushed off-screen
  var LEAF_SCALE = CFG.leafScale != null ? CFG.leafScale : 0.7;   // overall leaf size
  // torsion-spring constants (degrees, seconds)
  var STIFF = 40, DAMP = 5, SCROLL_SWAY = 3.5, SCROLL_FREQ = 3.0, MOUSE_K = 200, MAX_SWING = 14;
  // while scrolling, leaves get an extra SCROLL_SWAY-deg oscillation at SCROLL_FREQ rad/s (~2s period)

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

      // Resolution-independent size: leaves are sized from the VIEWPORT (capped), not the leftover
      // gutter — so they don't balloon on ultrawide or vanish on laptops. place() still clamps to
      // the gutter so they never cross the content; count scales with viewport height for density.
      var baseReach = Math.min(Math.max(vh * 0.30, 150), 320);
      LAYERS.forEach(function (layer) {
        var count = Math.max(2, Math.round(layer.count * vh / 850));
        var span = vh / count;
        for (var i = 0; i < count; i++) {
          var push = (EDGE_PUSH + rr(0, 60)) * LEAF_SCALE;           // hide the stem/base off-screen
          var anchorX = edge + (isLeft ? -push : push);
          var anchorY = (i + 0.5) * span + rr(-span * 0.35, span * 0.35);
          var desired = baseReach * layer.sizeFrac * LEAF_SCALE * (1 + qStep(0.20, 0.10));
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
  var mx = -1e4, my = -1e4, lastY = window.scrollY || 0, scrollAccum = 0, scrollActivity = 0;
  window.addEventListener("mousemove", function (e) { mx = e.clientX; my = e.clientY; }, { passive: true });
  window.addEventListener("mouseout", function (e) { if (!e.relatedTarget) { mx = -1e4; my = -1e4; } });
  // accumulate scroll distance; the frame loop turns it into a 0..1 "activity" that boosts the sway
  window.addEventListener("scroll", function () {
    var y = window.scrollY || 0; scrollAccum += Math.abs(y - lastY); lastY = y;
  }, { passive: true });

  var t0 = null, last = 0;
  function frame(ts) {
    if (t0 === null) { t0 = ts; last = ts; }
    var t = (ts - t0) / 1000;
    var dt = Math.min(0.05, Math.max(0.001, (ts - last) / 1000)); last = ts;
    // scroll activity: rises with scroll speed (0..1), fades smoothly when scrolling stops
    scrollActivity = Math.max(scrollActivity * 0.92, Math.min(1, scrollAccum / 45));
    scrollAccum = 0;

    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      // torsion spring (mouse wind only): restoring + damping
      var accel = -STIFF * it.theta - DAMP * it.omega;
      it.omega += accel * dt;
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

      // slow ambient idle sway + a gentle faster oscillation that scrolling fades in/out
      var sway = it.idleAmp * Math.sin(t * it.idleSpd + it.phase)
               + scrollActivity * SCROLL_SWAY * Math.sin(t * SCROLL_FREQ + it.phase);
      var ang = it.base + it.theta + sway;
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
