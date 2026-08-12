/* ============================================================================
 *  fb-detect.js — the detection core, isolated so it can be unit-tested
 *
 *  facebook.js is a content script: it cannot be require()'d, and it needs a
 *  live page to do anything. Everything genuinely worth testing lives here
 *  instead — the text normalization, the label tables, and the visible-text
 *  reconstruction that defeats Facebook's decoy-character obfuscation.
 *
 *  In the browser this attaches to window.ABPDetect.
 *  Under Node (tests/) it exports the same object via module.exports.
 * ========================================================================== */

(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.ABPDetect = api;
})(typeof self !== "undefined" ? self : (typeof window !== "undefined" ? window : null), function () {
  "use strict";

  /* ---------------------------------------------------------------- *
   * Normalization                                                     *
   * ---------------------------------------------------------------- */

  var DIACRITICS = /[ؐ-ًؚ-ٰٟۖ-ۭـ]/g;
  /* Invisible characters used as decoys.
   *
   * Confirmed live on facebook.com (Aug 2026): Facebook interleaves
   * U+034F COMBINING GRAPHEME JOINER between EVERY letter of its labels,
   * each in its own zero-width text node. "Learn more" arrives as:
   *     L ͏ e a ͏ r ͏ n ͏ ͏ m ͏ o ͏ ͏ r e ͏
   * The geometry filter already discards them, but stripping them here too
   * means normalization stays correct even if a rect measurement is missed.
   */
  var INVISIBLE  = /[͏​-‏‪-‮⁠-⁤﻿­᠎]/g;

  // Hebrew, Arabic, Syriac, Thaana, Arabic Supplement/Extended and the
  // Arabic presentation forms. Used to decide reading direction.
  var RTL_CHAR = /[֐-׿؀-ۿ܀-ݏݐ-ݿހ-޿ࢠ-ࣿיִ-﷿ﹰ-﻿]/;

  function norm(s) {
    if (!s) return "";
    try {
      return String(s)
        .replace(INVISIBLE, "")
        .replace(DIACRITICS, "")
        .replace(/[آأإٱ]/g, "ا")
        .replace(/ة/g, "ه")
        .replace(/[ىی]/g, "ي")
        .toLowerCase()
        .replace(/[^\p{L}\p{N} ]/gu, " ")
        .replace(/\s+/g, " ")
        .trim();
    } catch (_) {
      return String(s).toLowerCase().trim();
    }
  }

  function normList(arr) {
    var out = [];
    for (var i = 0; i < arr.length; i++) {
      var v = norm(arr[i]);
      if (v && out.indexOf(v) === -1) out.push(v);
    }
    return out;
  }

  var SPONSORED = normList([
    "Sponsored", "Sponsored Post", "Ad", "Ads", "Promoted", "Paid", "Commercial",
    "مُموَّل", "ممول", "مموّل", "برعاية", "بِرعاية",
    "إعلان", "اعلان", "إعلانات", "اعلانات",
    "إعلان مُموَّل", "منشور مُموَّل", "محتوى مُموَّل",
    "إعلان مدفوع", "اعلان مدفوع", "إعلان ترويجي", "اعلان ترويجي",
    "منشور إعلاني", "محتوى إعلاني",
    "Paid partnership", "شراكة مدفوعة",
    "Sponsorisé", "Commandité", "Patrocinado", "Publicidad",
    "Gesponsert", "Anzeige", "Sponsorizzato", "Sponsorlu",
    "Bersponsor", "Disponsori", "प्रायोजित", "সৌজন্যে",
    "Được tài trợ", "赞助内容", "贊助", "スポンサー", "広告",
    "스폰서", "Реклама", "Спонсируется",
    "سپانسرڈ", "اسپانسر شده", "ממומן"
  ]);

  var SUGGESTED = normList([
    "Suggested for you", "Suggested Post",
    "مقترح لك", "اقتراح لك", "منشور مقترح", "مُقترح لك",
    "Suggéré pour vous", "Sugerido para ti",
    "Vorgeschlagen für dich", "Sizin için önerilen", "Disarankan untuk Anda"
  ]);

  /** Exact match, or the label followed by a short separator/timestamp. */
  function matchesAny(text, list) {
    if (!text) return false;
    for (var i = 0; i < list.length; i++) {
      var l = list[i];
      if (text === l) return true;
      if (text.indexOf(l) === 0) {
        var nextChar = text.charAt(l.length);
        // Word boundary check: next char must not be an alphanumeric letter or digit
        if (nextChar && /[a-zA-Z0-9\u0600-\u06FF]/i.test(nextChar)) continue;

        var rest = text.slice(l.length).trim();
        if (l.length <= 3) {
          if (!rest) return true;
          // For short labels like "ad" or "ads", rest must be a separator or timestamp/icon (not words like "center" or "manager")
          if (/^[^a-z0-9]/i.test(rest) || /^(\d+[hmds]|🌐)/i.test(rest)) return true;
          continue;
        }

        if (text.length <= l.length + 12) return true;
      }
    }
    return false;
  }

  /** Looser containment test, for cards where the label sits among other text. */
  function containsAny(text, list) {
    if (!text) return false;
    for (var i = 0; i < list.length; i++) {
      if (text.indexOf(list[i]) !== -1) return true;
    }
    return false;
  }

  /* ---------------------------------------------------------------- *
   * Visibility                                                        *
   * ---------------------------------------------------------------- */

  function ancestorHidden(el, stopAt, getStyle) {
    var n = el, depth = 0;
    while (n && n !== stopAt && n.nodeType === 1 && depth++ < 12) {
      var cs;
      try { cs = getStyle(n); } catch (_) { return false; }
      if (!cs) return false;

      if (cs.display === "none") return true;
      if (cs.visibility === "hidden" || cs.visibility === "collapse") return true;
      if (parseFloat(cs.opacity) === 0) return true;

      if (cs.position === "absolute" || cs.position === "fixed") {
        var l = parseFloat(cs.left), t = parseFloat(cs.top);
        if ((!isNaN(l) && l < -400) || (!isNaN(t) && t < -400)) return true;
      }
      if (cs.clip && cs.clip !== "auto" && /rect\(\s*0/.test(cs.clip)) return true;
      if (cs.clipPath && /inset\(\s*(100%|50%\s+50%)/.test(cs.clipPath)) return true;
      if (cs.textIndent && parseFloat(cs.textIndent) < -400) return true;
      if (cs.fontSize && parseFloat(cs.fontSize) < 1) return true;

      n = n.parentElement;
    }
    return false;
  }

  /**
   * Is this fragment scrolled or clipped out of an ancestor's visible box?
   *
   * Facebook's fourth obfuscation layer, found live in August 2026: decoy
   * letters are given a real position and a real size — so they survive every
   * display/visibility/opacity test — but they sit OUTSIDE an ancestor that
   * has `overflow: hidden`. The browser clips them, the user never sees them,
   * yet getBoundingClientRect happily reports a normal rectangle.
   *
   * The result was labels reading "sponsoredontrsdseop05fu935tca120a1t285..."
   * instead of "sponsored", which then failed the length check and was
   * discarded — so the ad was never blocked.
   *
   * The fix is to intersect the fragment against every clipping ancestor.
   */
  function clippedOut(el, rect, getStyle) {
    var n = el, depth = 0;
    while (n && n.nodeType === 1 && depth++ < 20) {
      var cs;
      try { cs = getStyle(n); } catch (_) { return false; }
      if (!cs) return false;

      var clips = cs.overflow === "hidden" || cs.overflow === "clip" ||
                  cs.overflowX === "hidden" || cs.overflowX === "clip" ||
                  cs.overflowY === "hidden" || cs.overflowY === "clip";

      if (clips) {
        var box;
        try { box = n.getBoundingClientRect(); } catch (_) { box = null; }
        if (box && box.width > 0 && box.height > 0) {
          // No overlap with the clip box means the user cannot see it.
          if (rect.right  <= box.left + 0.5 ||
              rect.left   >= box.right - 0.5 ||
              rect.bottom <= box.top + 0.5 ||
              rect.top    >= box.bottom - 0.5) return true;
        }
      }
      n = n.parentElement;
    }
    return false;
  }

  /** Text painted in a fully transparent colour is not readable either.
   *
   *  Must match rgba() with FOUR components only. A loose pattern here reads
   *  the blue channel of `rgb(0, 0, 0)` as an alpha of 0 and concludes that
   *  ordinary black text is invisible — which silently blanks every label.
   */
  function transparentText(cs) {
    if (!cs || !cs.color) return false;
    var c = String(cs.color).trim();
    if (c === "transparent") return true;
    var m = /^rgba\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*,\s*([\d.]+)\s*\)$/.exec(c);
    return !!m && parseFloat(m[1]) === 0;
  }

  /**
   * Reconstruct the string a human actually reads inside `root`.
   *
   * Facebook hides decoy characters with CSS and scrambles DOM order with
   * flexbox. Both are defeated by measuring where each text fragment really
   * lands on screen and sorting by that, because visual position is the one
   * thing Facebook cannot fake without changing what the user sees.
   *
   * @param {Element}  root
   * @param {object}   env  { doc, getStyle, NodeFilter }
   */
  function visibleText(root, env) {
    if (!root) return "";

    var doc = env.doc;
    var getStyle = env.getStyle;
    var frags = [];
    var walker;

    // Bounds beyond which text cannot be seen. Generous, so that ordinary
    // content sitting below the fold is never mistaken for a decoy.
    var OFFCANVAS = -1500;
    var MAX_X = (env.maxX !== undefined) ? env.maxX : 20000;

    try {
      walker = doc.createTreeWalker(root, env.SHOW_TEXT, null);
    } catch (_) {
      return "";
    }

    var node, guard = 0;
    while ((node = walker.nextNode()) && guard++ < 400) {
      var raw = node.textContent;
      if (!raw || !raw.trim()) continue;

      var parent = node.parentElement;
      if (!parent) continue;
      if (ancestorHidden(parent, root.parentElement, getStyle)) continue;

      var rect;
      try {
        var range = doc.createRange();
        range.selectNodeContents(node);
        rect = range.getBoundingClientRect();
        if (range.detach) range.detach();
      } catch (_) { continue; }

      if (!rect || rect.width < 0.5 || rect.height < 0.5) continue;

      // Parked off-canvas.
      //
      // Facebook keeps screen-reader and template text at coordinates like
      // x=-9980, y=-10001. Those elements are not display:none, not
      // visibility:hidden, and their ancestors are not always positioned, so
      // the style checks let them through — and the reconstruction then reads
      // "FacebookFacebookFacebook..." as if it were on screen.
      //
      // Anything this far outside the canvas cannot be read by a human.
      if (rect.right < OFFCANVAS || rect.bottom < OFFCANVAS) continue;
      if (rect.left > MAX_X) continue;

      // Real size, real position — but clipped away by an ancestor.
      if (clippedOut(parent, rect, getStyle)) continue;

      var pcs;
      try { pcs = getStyle(parent); } catch (_) { pcs = null; }
      if (transparentText(pcs)) continue;

      frags.push({ x: rect.left, y: rect.top, t: raw });
    }

    if (!frags.length) return "";

    // Reading order depends on script direction. Sorting left-to-right is
    // correct for Latin text but REVERSES Arabic and Hebrew, which read
    // right-to-left: the first character sits at the largest x, not the
    // smallest. Detect the script from the fragments themselves rather than
    // trusting a `dir` attribute, which Facebook does not always set.
    var rtl = false;
    for (var f = 0; f < frags.length; f++) {
      if (RTL_CHAR.test(frags[f].t)) { rtl = true; break; }
    }

    frags.sort(function (a, b) {
      var dy = a.y - b.y;
      if (Math.abs(dy) > 4) return dy;          // earlier line first, always
      return rtl ? (b.x - a.x) : (a.x - b.x);   // then by column, per script
    });

    var out = "";
    for (var i = 0; i < frags.length; i++) out += frags[i].t;
    return out;
  }

  /** Convenience: visible text of an element, already normalized. */
  function readLabel(el, env) {
    var txt = visibleText(el, env);

    // SVG <use xlink:href="#SvgId"> resolution
    // Facebook live obfuscation technique (Aug 2026): Facebook renders "Sponsored" labels
    // using inline SVG <use> tags referencing <text id="..."> elements in root <defs>.
    if (el) {
      try {
        var uses = el.querySelectorAll ? el.querySelectorAll("use") : [];
        if (uses && uses.length > 0) {
          var svgText = "";
          for (var u = 0; u < uses.length; u++) {
            var useEl = uses[u];
            var href = useEl.getAttribute ? (useEl.getAttribute("xlink:href") || useEl.getAttribute("href")) : null;
            if (href && href.charAt(0) === "#") {
              var targetId = href.slice(1);
              var doc = (env && env.doc) || (el.ownerDocument || document);
              var targetEl = doc.getElementById ? doc.getElementById(targetId) : null;
              if (targetEl) {
                var tContent = targetEl.textContent || targetEl.innerText || "";
                if (tContent) svgText += " " + tContent;
              }
            }
          }
          if (svgText.trim()) txt = (txt + " " + svgText).trim();
        }
      } catch (_) {}
    }

    if (txt) return norm(txt);

    // Fallback: check aria-label, title, or data-content if visibleText is empty
    if (el) {
      try {
        var aria = el.getAttribute ? (el.getAttribute("aria-label") || el.getAttribute("title") || el.getAttribute("data-content")) : null;
        if (aria) return norm(aria);
      } catch (_) {}
    }
    return "";
  }

  return {
    norm: norm,
    normList: normList,
    SPONSORED: SPONSORED,
    SUGGESTED: SUGGESTED,
    matchesAny: matchesAny,
    containsAny: containsAny,
    ancestorHidden: ancestorHidden,
    visibleText: visibleText,
    readLabel: readLabel
  };
});
