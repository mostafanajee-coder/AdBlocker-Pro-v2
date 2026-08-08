/* ============================================================================
 *  youtube.js — YouTube ad handling for Ad Blocker Pro
 *
 *  Like Facebook, YouTube serves its ads from its own domain and player, so
 *  network blocking is useless: the ad arrives inside the same video stream
 *  infrastructure as the content. Blocking it at the network layer breaks
 *  playback entirely.
 *
 *  So this module works inside the player instead:
 *
 *    1. Video ads   — clicks Skip the moment it appears; for unskippable ads
 *                     it seeks to the end of the ad, which YouTube accepts as
 *                     "watched" and moves on immediately.
 *    2. Overlay ads — dismisses the banner overlaid on the video.
 *    3. Static ads  — hides masthead, sidebar and in-feed promoted slots.
 *
 *  HONEST NOTE
 *  -----------
 *  YouTube actively works against this and changes its player regularly.
 *  Expect this file to need maintenance. It is deliberately written around
 *  YouTube's own semantic class names (`.ytp-ad-*`, `ytd-ad-slot-renderer`)
 *  which change less often than layout markup, but they do change.
 * ========================================================================== */

(function () {
  "use strict";

  if (window.__abpYT__) return;
  window.__abpYT__ = true;

  var S = { adBlock: true, ytSkip: true, ytHide: true, ytCurtain: true };
  var skipped = 0;

  /* ---------------------------------------------------------------- *
   * Static ad slots                                                   *
   * ---------------------------------------------------------------- */

  var HIDE_SELECTORS = [
    "ytd-ad-slot-renderer",
    "ytd-in-feed-ad-layout-renderer",
    "ytd-banner-promo-renderer",
    "ytd-video-masthead-ad-v3-renderer",
    "ytd-primetime-promo-renderer",
    "ytd-statement-banner-renderer",
    "ytd-promoted-sparkles-web-renderer",
    "ytd-promoted-video-renderer",
    "ytd-compact-promoted-video-renderer",
    "ytd-display-ad-renderer",
    "ytm-promoted-video-renderer",
    "#masthead-ad",
    "#player-ads",
    ".ytp-ad-overlay-container",
    ".ytd-merch-shelf-renderer",
    "ytd-engagement-panel-section-list-renderer[target-id='engagement-panel-ads']"
  ];

  function injectCss() {
    if (!S.adBlock || !S.ytHide) return;
    if (document.getElementById("abp-yt-css")) return;

    var style = document.createElement("style");
    style.id = "abp-yt-css";
    style.textContent = HIDE_SELECTORS.join(",\n") +
      " { display: none !important; }\n" +
      /* collapse the gap an ad slot leaves behind in the grid */
      "ytd-rich-item-renderer:has(> #content > ytd-ad-slot-renderer) { display: none !important; }\n" +
      /* the in-player ad call-to-action panels */
      ".ytp-ad-avatar-lockup-card, .ytp-ad-action-interstitial," +
      ".ytp-ad-image-overlay, .ytp-ad-overlay-slot" +
      " { display: none !important; }";

    (document.head || document.documentElement).appendChild(style);
  }

  /* ---------------------------------------------------------------- *
   * In-player video ads                                               *
   * ---------------------------------------------------------------- */

  var SKIP_BUTTONS = [
    ".ytp-ad-skip-button",
    ".ytp-ad-skip-button-modern",
    ".ytp-skip-ad-button",
    ".ytp-ad-survey-answer-button",
    "button.ytp-ad-skip-button-container",
    ".ytp-skip-ad-button__text",
    "[class*='skip-ad-button']",
    "[id*='skip-button']",
    "button[aria-label*='Skip' i]",
    "button[aria-label*='تخطي']"
  ].join(",");

  var DISMISS_BUTTONS = [
    ".ytp-ad-overlay-close-button",
    ".ytp-ad-overlay-close-container",
    ".ytp-featured-product-close-button"
  ].join(",");

  /* Ad detection.
   *
   * v1 relied solely on the `ad-showing` class on .html5-video-player. On the
   * ad layout YouTube shipped in 2026 that class is not always applied, so
   * detection failed completely and the curtain never dropped — the ad played
   * in full view.
   *
   * Detection now uses several independent signals. YouTube can rename any
   * one of them, but it is unlikely to rename all at once, and each extra
   * signal only costs a selector match.
   */
  var AD_SIGNALS = [
    ".ytp-ad-player-overlay",
    ".ytp-ad-player-overlay-layout",
    ".ytp-ad-badge",
    ".ytp-ad-simple-ad-badge",
    ".ytp-ad-text",
    ".ytp-ad-preview-container",
    ".ytp-ad-module",
    ".ytp-ad-avatar-lockup-card",
    ".ytp-ad-action-interstitial",
    ".ytp-ad-image-overlay"
  ].join(",");

  var lastReason = "none";

  function playerShowingAd() {
    var p = document.querySelector(".html5-video-player");

    // 1. the classic marker, when present
    if (p && (p.classList.contains("ad-showing") ||
              p.classList.contains("ad-interrupting"))) {
      lastReason = "class";
      return true;
    }

    // 2. any ad chrome that is actually painted
    var els = document.querySelectorAll(AD_SIGNALS);
    for (var i = 0; i < els.length; i++) {
      var r = els[i].getBoundingClientRect();
      if (r.width > 2 && r.height > 2) { lastReason = "overlay"; return true; }
    }

    // 3. a visible Skip control means an ad is running, whatever it is called
    var skip = document.querySelector(SKIP_BUTTONS);
    if (skip) {
      var sr = skip.getBoundingClientRect();
      if (sr.width > 2 && sr.height > 2) { lastReason = "skip-btn"; return true; }
    }

    lastReason = "none";
    return false;
  }

  /* Diagnostic marker on <html>, readable from the page console:
   *   data-abp-yt = "<detectionReason>/<adsHandled>"                       */
  function ytMark() {
    try {
      document.documentElement.setAttribute("data-abp-yt", lastReason + "/" + skipped);
    } catch (_) {}
  }

  /* ---------------------------------------------------------------- *
   * Curtain                                                           *
   *                                                                   *
   * Skipping alone is not enough for a child watching. Between the ad *
   * starting and the skip landing there is a gap of a few hundred     *
   * milliseconds, and in that gap the ad is on screen with sound.     *
   *                                                                   *
   * So the first thing we do on detecting an ad is drop an opaque     *
   * cover over the player and mute it. The ad may still be playing    *
   * underneath, but it is neither seen nor heard. The cover lifts the *
   * moment the ad ends.                                               *
   * ---------------------------------------------------------------- */

  var curtain = null;

  function showCurtain(player) {
    if (!S.ytCurtain) return;
    if (curtain && curtain.isConnected) { curtain.style.display = "flex"; return; }

    curtain = document.createElement("div");
    curtain.id = "abp-yt-curtain";
    curtain.setAttribute("style", [
      "position:absolute", "inset:0", "z-index:2147483000",
      "background:#0b0b0b", "display:flex",
      "align-items:center", "justify-content:center",
      "color:#8a8a8a", "font:600 14px/1.5 system-ui,sans-serif",
      "letter-spacing:.5px", "pointer-events:none", "user-select:none"
    ].join(";"));
    curtain.textContent = "…";

    try {
      if (getComputedStyle(player).position === "static") {
        player.style.position = "relative";
      }
      player.appendChild(curtain);
    } catch (_) { curtain = null; }
  }

  function hideCurtain() {
    if (curtain && curtain.isConnected) curtain.style.display = "none";
  }

  var restoreVolume = null;

  function handleAds() {
    if (!S.adBlock || !S.ytSkip) return;
    ytMark();

    // 1. dismiss overlay banners
    var dismiss = document.querySelector(DISMISS_BUTTONS);
    if (dismiss) { try { dismiss.click(); } catch (_) {} }

    var player = document.querySelector(".html5-video-player");
    var video = document.querySelector("video.html5-main-video, video.video-stream");

    if (!playerShowingAd()) {
      // Ad over: lift the cover and give the sound back.
      hideCurtain();
      if (video && restoreVolume !== null) {
        try { video.muted = restoreVolume; } catch (_) {}
        restoreVolume = null;
      }
      return;
    }

    // 2. cover and silence FIRST — before anything can be seen or heard
    if (player) showCurtain(player);
    if (video) {
      try {
        if (restoreVolume === null) restoreVolume = video.muted;
        video.muted = true;
      } catch (_) {}
    }

    // 3. a visible Skip button is the cleanest exit
    var skip = document.querySelector(SKIP_BUTTONS);
    if (skip && skip.offsetParent !== null) {
      try {
        skip.click();
        skipped++;
        report();
        return;
      } catch (_) {}
    }

    // 4. unskippable: jump to the end. YouTube treats a completed ad the
    //    same whether it was watched or seeked through.
    if (video && isFinite(video.duration) && video.duration > 0) {
      if (video.currentTime < video.duration - 0.15) {
        try {
          video.currentTime = video.duration;
          video.playbackRate = 16;
          skipped++;
          report();
        } catch (_) {}
      }
    }
  }

  var reportTimer = null;
  function report() {
    if (reportTimer) return;
    reportTimer = setTimeout(function () {
      reportTimer = null;
      try { chrome.runtime.sendMessage({ type: "abpBlocked", count: skipped, host: "youtube" }); } catch (_) {}
    }, 800);
  }

  /* ---------------------------------------------------------------- *
   * Lifecycle                                                         *
   * ---------------------------------------------------------------- */

  function start() {
    injectCss();
    handleAds();

    // The player mutates constantly during an ad break, so a short poll is
    // both simpler and more reliable here than a MutationObserver.
    setInterval(handleAds, 120);

    var obs = new MutationObserver(function () { injectCss(); });
    obs.observe(document.documentElement, { childList: true, subtree: false });

    // YouTube is a single-page app: re-apply on navigation
    window.addEventListener("yt-navigate-finish", function () {
      injectCss(); handleAds();
    });
  }

  try {
    chrome.storage.local.get(null, function (cfg) {
      if (cfg) for (var k in S) if (cfg[k] !== undefined) S[k] = cfg[k];
      var wl = (cfg && cfg.whitelist) || [];
      if (wl.indexOf("youtube.com") !== -1) return;
      if (document.documentElement) start();
      else document.addEventListener("DOMContentLoaded", start);
    });

    chrome.storage.onChanged.addListener(function (ch) {
      for (var k in ch) if (k in S) S[k] = ch[k].newValue;
    });
  } catch (_) {
    start();
  }
})();
