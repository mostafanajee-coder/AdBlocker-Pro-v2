/* ============================================================================
 *  facebook.js  —  Facebook Sponsored-Content Annihilator
 *  Part of: Ad Blocker Pro
 *
 *  WHY THIS FILE EXISTS
 *  --------------------
 *  Facebook serves ads from its OWN domain, inside the same DOM structures as
 *  normal posts. Network-level blocking (declarativeNetRequest) cannot touch
 *  them, and CSS selectors are useless because class names are randomized
 *  (x1i10hfl, x1qjc9v5, ...) and rotate constantly.
 *
 *  Facebook also actively obfuscates the word "Sponsored" / "مُموَّل":
 *    - it splits the label across many <span> elements
 *    - it injects DECOY <span>s that are hidden via CSS (display:none,
 *      visibility:hidden, zero size, off-screen, clip-path)
 *    - it scrambles the DOM order and fixes it visually with flexbox `order`
 *
 *  So element.textContent returns garbage like "SpnoSsoernedo".
 *
 *  THE COUNTER-TECHNIQUE
 *  ---------------------
 *  We reconstruct what the user ACTUALLY SEES:
 *    1. walk every text node
 *    2. measure each one with a Range -> DOMRect
 *    3. drop anything with zero area or a hidden ancestor
 *    4. sort the surviving fragments by their real screen position (y, then x)
 *    5. join them
 *
 *  Visual position cannot be faked without changing what the user sees, so
 *  this survives class-name rotation and decoy injection.
 * ========================================================================== */

(function () {
  "use strict";

  if (window.__abpFB__) return;
  window.__abpFB__ = true;

  /* ------------------------------------------------------------------ *
   * 1. SETTINGS                                                         *
   * ------------------------------------------------------------------ */

  var S = {
    adBlock: true,
    fbSponsored: true,   // hide sponsored posts
    fbSuggested: false,  // hide "Suggested for you" posts
    fbReels: false,      // hide the Reels shelf entirely
    fbSidebar: true,     // hide right-rail sponsored column
    fbDebug: false       // outline instead of hide (for testing)
  };

  var blocked = 0;
  var seen = new WeakSet();      // containers already judged
  var pending = false;

  /* ------------------------------------------------------------------ *
   * 2-3. DETECTION CORE                                                 *
   *                                                                     *
   * The normalization tables and the visible-text reconstruction live   *
   * in fb-detect.js so they can be unit-tested under Node without a     *
   * browser. tests/fb-detect.test.js exercises them against synthetic   *
   * DOM trees that reproduce Facebook's decoy-character obfuscation.    *
   * Whatever runs here is exactly what the tests cover.                 *
   * ------------------------------------------------------------------ */

  /* Diagnostic marker.
   *
   * Content scripts run in an isolated world, so anything this file puts on
   * `window` is invisible from the page's own console — the default DevTools
   * context. The DOM, however, is shared between both worlds. Writing status
   * onto <html> is therefore the only way to inspect this module without
   * switching the console's execution context.
   *
   *   document.documentElement.dataset.abpFb
   *     "loading"  script started
   *     "no-core"  fb-detect.js failed to load
   *     "ready"    running normally
   */
  function mark(state, extra) {
    try {
      document.documentElement.setAttribute("data-abp-fb", state);
      if (extra) {
        for (var k in extra) document.documentElement.setAttribute("data-abp-" + k, extra[k]);
      }
    } catch (_) {}
  }

  mark("loading");

  var D = (typeof self !== "undefined" && self.ABPDetect) ||
          (typeof window !== "undefined" && window.ABPDetect);

  if (!D) {
    mark("no-core");
    console.warn("[Ad Blocker Pro] fb-detect.js did not load - Facebook module disabled.");
    return;
  }

  // Environment adapter: the detector is given its DOM access explicitly,
  // which is what makes it testable outside a browser.
  var ENV = {
    doc: document,
    getStyle: function (n) { return getComputedStyle(n); },
    SHOW_TEXT: NodeFilter.SHOW_TEXT
  };

  var norm       = D.norm;
  var SPONSORED  = D.SPONSORED;
  var SUGGESTED  = D.SUGGESTED;
  var matchesAny = D.matchesAny;

  function visibleText(root) { return D.visibleText(root, ENV); }
  function readLabel(root)   { return D.readLabel(root, ENV); }


  /* ------------------------------------------------------------------ *
   * 4. CONTAINER RESOLUTION  (geometry, not structure)                  *
   *                                                                     *
   * WHY THIS CHANGED                                                    *
   * ---------------                                                     *
   * v1 looked for `div[role="feed"]` and `[data-pagelet^="FeedUnit"]`.  *
   * A live inspection of facebook.com in August 2026 found that NEITHER *
   * exists any more: role="feed" is gone, data-pagelet is gone, and     *
   * only two or three div[role="article"] nodes exist on a whole page.  *
   * Every selector the module depended on was pointing at nothing.      *
   *                                                                     *
   * Geometry survives that kind of rewrite. A post is simply the card   *
   * that is as wide as the feed column and tall enough to hold content, *
   * so we climb until the box stops looking like a post. Facebook can   *
   * rename every class and drop every ARIA role without breaking this,  *
   * because it cannot change the shape of its own layout without        *
   * changing what the user sees.                                        *
   * ------------------------------------------------------------------ */

  var COLUMN_MIN = 340;    // narrower than this is a widget, not a post
  var COLUMN_MAX = 920;    // wider than this is the page shell
  var POST_MIN_H = 120;

  function postContainerOf(el) {
    if (!el) return null;
    if (el.closest && el.closest('[role="navigation"], nav, header')) return null;
    var n = el, best = null;

    var isReel = (window.location && window.location.pathname.indexOf("/reel") !== -1) ||
                 (el.closest && el.closest('[scrollable="true"], [aria-label*="Reel" i], [data-pagelet*="Reel" i]'));

    var maxW = isReel ? 1400 : COLUMN_MAX;

    for (var i = 0; i < 25 && n && n.parentElement; i++) {
      n = n.parentElement;
      if (n.getAttribute && (n.getAttribute("role") === "navigation" || n.tagName === "NAV" || n.tagName === "HEADER")) break;
      var r = n.getBoundingClientRect();
      if (r.width > maxW) break;                 // climbed out of the column / reel
      if (r.width >= COLUMN_MIN && r.height >= POST_MIN_H) best = n;
    }
    return best;
  }

  /* ------------------------------------------------------------------ *
   * 5. HIDING                                                           *
   * ------------------------------------------------------------------ */

  function hide(el, reason) {
    if (!el || el.__abpHidden) return false;
    el.__abpHidden = true;
    el.setAttribute("data-abp-blocked", reason);

    // Stop and silence any video playing inside the blocked ad container (critical for Reels)
    try {
      var vids = el.querySelectorAll("video");
      for (var v = 0; v < vids.length; v++) {
        vids[v].pause();
        vids[v].muted = true;
        vids[v].src = "";
      }
    } catch (_) {}

    // Record the box BEFORE hiding. Once display:none is applied every
    // measurement reads 0x0, which makes after-the-fact diagnosis useless
    // and can look like a bug that is not there.
    try {
      var pre = el.getBoundingClientRect();
      el.setAttribute("data-abp-size", Math.round(pre.width) + "x" + Math.round(pre.height));
    } catch (_) {}

    if (S.fbDebug) {
      el.style.setProperty("outline", "3px solid #e53935", "important");
      el.style.setProperty("outline-offset", "-3px", "important");
      el.style.setProperty("opacity", "0.45", "important");
      blocked++;
      mark("ready", { "fb-blocked": blocked });
      return true;
    }

    el.style.setProperty("display", "none", "important");
    el.style.setProperty("height", "0", "important");
    el.style.setProperty("min-height", "0", "important");
    el.style.setProperty("margin", "0", "important");
    el.style.setProperty("padding", "0", "important");

    blocked++;
    mark("ready", { "fb-blocked": blocked });
    report();
    return true;
  }

  var reportTimer = null;
  function report() {
    if (reportTimer) return;
    reportTimer = setTimeout(function () {
      reportTimer = null;
      try { chrome.runtime.sendMessage({ type: "abpBlocked", count: blocked, host: "facebook" }); } catch (_) {}
    }, 600);
  }

  /* ------------------------------------------------------------------ *
   * 6. LABEL DISCOVERY                                                  *
   *                                                                     *
   * Inverted from v1. Instead of finding posts and searching inside     *
   * them for a label, we find labels anywhere and derive the post from  *
   * the label. That removes every assumption about page structure.      *
   *                                                                     *
   * The cost is scanning many elements, so the scan is bounded three    *
   * ways: a geometry pre-filter that only a one-line label can pass, a  *
   * WeakSet so nothing is measured twice, and a work budget per pass.   *
   * ------------------------------------------------------------------ */

  var LABEL_MIN_W = 8,   LABEL_MAX_W = 380;
  var LABEL_MIN_H = 8,   LABEL_MAX_H = 40;
  var BUDGET = 2500;               // elements measured per pass

  /* Telemetry, written to <html> so it can be read from the page console
   * without switching DevTools into the extension's isolated world.
   *
   *   data-abp-scan   "<candidates>/<measured>/<nearMisses>"
   *   data-abp-near   the closest non-matching label text seen
   *
   * A near miss is any reconstructed label containing a sponsor word without
   * matching the strict test — that is the signal that tells us whether the
   * reconstruction works and only the comparison is wrong, or whether the
   * reconstruction itself is returning nothing.
   */
  var NEAR = /sponsor|ممول|مموّل|رعاي|patrocin|gesponsert/i;

  var diag = { candidates: 0, measured: 0, near: 0, sample: "" };

  function findLabels() {
    var results = [];
    var els = document.querySelectorAll("span, a, div");
    var vh = window.innerHeight || 900;
    var work = 0;

    diag.candidates = 0;
    diag.measured = 0;

    for (var i = 0; i < els.length && work < BUDGET; i++) {
      var e = els[i];
      if (seen.has(e) || e.__abpHidden) continue;

      var r = e.getBoundingClientRect();

      // Only measure what is on, or just off, the screen.
      if (r.bottom < -600 || r.top > vh + 1200) continue;
      if (r.height < LABEL_MIN_H || r.height > LABEL_MAX_H) continue;
      if (r.width  < LABEL_MIN_W || r.width  > LABEL_MAX_W) continue;

      // Parked off-canvas horizontally.
      //
      // The vertical range above was not enough: Facebook parks its
      // screen-reader containers at x = -9980, which passes every vertical
      // test. Those containers matched, and the geometry walk then hid a
      // wrapper full of repeated "Facebook" strings instead of an ad.
      if (r.right < 0 || r.left < -1000) continue;

      diag.candidates++;
      seen.add(e);
      if (e.querySelectorAll("*").length > 120) continue;

      work++;
      diag.measured++;

      var lab = readLabel(e);
      if (!lab) continue;

      if (lab.length <= 45) {
        if (S.fbSponsored && matchesAny(lab, SPONSORED)) {
          results.push({ el: e, kind: "sponsored", label: lab });
          continue;
        }
        if (S.fbSuggested && matchesAny(lab, SUGGESTED)) {
          results.push({ el: e, kind: "suggested", label: lab });
          continue;
        }
      }

      // Did we read the word but fail to match it?
      if (NEAR.test(lab)) {
        diag.near++;
        if (!diag.sample || lab.length < diag.sample.length) {
          diag.sample = lab.slice(0, 60);
        }
      }
    }

    mark("ready", {
      "fb-scan": diag.candidates + "/" + diag.measured + "/" + diag.near,
      "fb-near": diag.sample || "none"
    });

    return results;
  }

  /* ------------------------------------------------------------------ *
   * 7. SWEEPS                                                           *
   * ------------------------------------------------------------------ */

  function sweepLabels() {
    if (!S.adBlock) return;
    if (!S.fbSponsored && !S.fbSuggested) return;

    var found = findLabels();

    for (var i = 0; i < found.length; i++) {
      var hit = found[i];

      // Sidebar ads live in a narrow column; the same geometry walk finds
      // their card too, so one code path covers feed and rail alike.
      var container = postContainerOf(hit.el);
      if (!container) continue;

      var cr = container.getBoundingClientRect();

      // ---- safety guards -------------------------------------------------
      // Hiding the wrong node is far worse than missing an ad, so a container
      // must positively look like a post before anything is collapsed.

      // 1. Never collapse something enormous — that would blank the page.
      if (cr.height > 2600) continue;

      // 2. It must actually be on the canvas.
      if (cr.right < 0 || cr.left < -1000) continue;

      // 3. The label must sit visually INSIDE its own container. A DOM
      //    ancestor that the label is not painted within is not the post —
      //    this is what caught the off-canvas screen-reader wrapper.
      var lr = hit.el.getBoundingClientRect();
      if (lr.left   < cr.left   - 4 || lr.right  > cr.right  + 4 ||
          lr.top    < cr.top    - 4 || lr.bottom > cr.bottom + 4) continue;

      hide(container, hit.kind);
    }
  }

  /** Optional: remove the Reels shelf from the feed. */
  function sweepReels() {
    if (!S.adBlock || !S.fbReels) return;

    var links = document.querySelectorAll('a[href*="/reel/"]');
    for (var i = 0; i < links.length && i < 40; i++) {
      var shelf = postContainerOf(links[i]);
      if (shelf && !shelf.__abpHidden) hide(shelf, "reels");
    }
  }

  var REEL_CTA_TERMS = D.normList([
    "Learn more", "Shop now", "Sign up", "Install now", "Download", "Play game",
    "Get offer", "Watch more", "Apply now", "Contact us", "Send message",
    "Book now", "Open link", "Use app", "Play now",
    "تعرف على المزيد", "تسوق الآن", "تسجيل", "تثبيت الآن", "تنزيل", "العب الآن",
    "احصل على العرض", "شاهد المزيد", "قدم الآن", "اتصل بنا", "إرسال رسالة",
    "احجز الآن", "فتح الرابط", "استخدام التطبيق"
  ]);

  /** Dedicated sweeper for Facebook Reels ads */
  function sweepReelAds() {
    if (!S.adBlock || (!S.fbSponsored && !S.fbSuggested)) return;
    var isReelsPage = (window.location && window.location.pathname.indexOf("/reel") !== -1) ||
                      document.querySelector('div[scrollable="true"]');
    if (!isReelsPage) return;

    var reelCards = document.querySelectorAll('div[scrollable="true"] > div, div[role="section"], div[aria-label*="Reel" i]');
    for (var i = 0; i < reelCards.length && i < 30; i++) {
      var card = reelCards[i];
      if (!card || card.__abpHidden) continue;

      var cr = card.getBoundingClientRect();
      if (cr.width < 100 || cr.height < 100) continue;

      var isAd = false;

      // 1. Check for ad redirect links
      if (card.querySelector('a[href*="l.facebook.com/l.php"], a[href*="/ads/about"], a[href*="/ads/"]')) {
        isAd = true;
      }

      // 2. Check for explicit ARIA labels on child elements
      if (!isAd) {
        var ariaEls = card.querySelectorAll('[aria-label]');
        for (var a = 0; a < ariaEls.length; a++) {
          var labelText = norm(ariaEls[a].getAttribute("aria-label"));
          if (labelText && matchesAny(labelText, SPONSORED)) {
            isAd = true;
            break;
          }
        }
      }

      // 3. Check for CTA terms (Call-To-Action buttons exist ONLY on sponsored Reels)
      if (!isAd) {
        var fullText = norm(card.innerText || "");
        if (fullText) {
          for (var c = 0; c < REEL_CTA_TERMS.length; c++) {
            if (fullText.indexOf(REEL_CTA_TERMS[c]) !== -1) {
              isAd = true;
              break;
            }
          }
        }
      }

      // 4. Check via visual geometry detector
      if (!isAd) {
        var found = findLabels();
        for (var j = 0; j < found.length; j++) {
          if (card.contains(found[j].el)) {
            isAd = true;
            break;
          }
        }
      }

      if (isAd) {
        hide(card, "sponsored-reel");
      }
    }
  }

  function sweep() {
    pending = false;
    try { sweepLabels(); } catch (_) {}
    try { sweepReels(); } catch (_) {}
    try { sweepReelAds(); } catch (_) {}
  }

  function schedule() {
    if (pending) return;
    pending = true;
    var run = function () { sweep(); };
    if (window.requestIdleCallback) requestIdleCallback(run, { timeout: 400 });
    else setTimeout(run, 80);
  }


  /* ------------------------------------------------------------------ *
   * 8. LIFECYCLE                                                        *
   * ------------------------------------------------------------------ */

  function start() {
    mark("ready", { "fb-labels": SPONSORED.length });
    sweep();

    var observer = new MutationObserver(function () { schedule(); });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true
    });

    // Capture phase listeners so scrolling inside Reels containers (div[scrollable="true"]) instantly triggers schedule
    window.addEventListener("scroll", schedule, { passive: true, capture: true });
    window.addEventListener("wheel", schedule, { passive: true, capture: true });
    window.addEventListener("keydown", schedule, { passive: true, capture: true });
    window.addEventListener("touchmove", schedule, { passive: true, capture: true });

    setInterval(function () { seen = new WeakSet(); schedule(); }, 2000);
  }

  function boot() {
    try {
      chrome.storage.local.get(null, function (cfg) {
        if (cfg) for (var k in S) if (cfg[k] !== undefined) S[k] = cfg[k];

        // Respect the extension's whitelist
        var wl = (cfg && cfg.whitelist) || [];
        if (wl.indexOf("facebook.com") !== -1) return;

        if (document.body) start();
        else document.addEventListener("DOMContentLoaded", start);
      });
    } catch (_) {
      if (document.body) start();
      else document.addEventListener("DOMContentLoaded", start);
    }
  }

  // Live-update when the popup toggles something
  try {
    chrome.storage.onChanged.addListener(function (changes) {
      for (var k in changes) if (k in S) S[k] = changes[k].newValue;
      seen = new WeakSet();
      schedule();
    });
  } catch (_) {}

  boot();
})();
