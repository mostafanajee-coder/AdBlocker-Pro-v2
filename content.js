(function () {
  function getRoot() {
    return document.documentElement || document.head || document.body;
  }

  function isWhitelisted(hostname, list) {
    if (!hostname || !list) return false;
    var parts = hostname.split(".");
    for (var i = 0; i < parts.length - 1; i++) {
      var domain = parts.slice(i).join(".");
      if (list.indexOf(domain) !== -1) return true;
    }
    return false;
  }

  function shouldSkip(target) {
    var tag = target && target.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || (target && target.isContentEditable);
  }

  function applyCosmeticFilters(settings) {
    if (!settings.adBlock && !settings.antiAdblock) return;

    var builtin = [
      ".ad-banner, .ad-container, .ad-wrapper,",
      "ins.adsbygoogle, .sponsored-post,",
      ".sponsored-content, [class*=\"sponsored\"],",
      '[id*="google_ads"], [id*="taboola"], [id*="outbrain"]'
    ].join("\n");

    var css = builtin + " { display: none !important; }";

    // Generic element-hiding selectors harvested from the filter lists.
    // Chunked, because one malformed selector invalidates its entire rule
    // block in CSS — chunking limits the blast radius to 200 selectors.
    var extra = settings.cosmeticCss;
    if (settings.adBlock && Array.isArray(extra) && extra.length) {
      for (var i = 0; i < extra.length; i += 200) {
        var chunk = extra.slice(i, i + 200).join(",\n");
        if (chunk) css += "\n" + chunk + " { display: none !important; }";
      }
    }

    var style = document.createElement("style");
    style.textContent = css;
    var root = getRoot();
    if (root) {
      root.appendChild(style);
    } else {
      document.addEventListener("DOMContentLoaded", function () {
        (document.head || document.body || document.documentElement).appendChild(style);
      });
    }
  }

  function applyMouseUnlock(settings) {
    if (!settings.mouseUnlock) return;
    var events = ["contextmenu", "copy", "cut", "selectstart", "dragstart"];
    for (var i = 0; i < events.length; i++) {
      document.addEventListener(events[i], function (e) {
        if (shouldSkip(e.target)) return;
        e.stopPropagation();
        e.stopImmediatePropagation();
      }, true);
    }
    var css = [
      "html, body, html *, body * {",
      "  user-select: auto !important;",
      "  -webkit-user-select: auto !important;",
      "  -moz-user-select: auto !important;",
      "  -ms-user-select: auto !important;",
      "  pointer-events: auto !important;",
      "}"
    ].join("\n");
    var style = document.createElement("style");
    style.textContent = css;
    var root = getRoot();
    if (root) {
      root.appendChild(style);
    } else {
      document.addEventListener("DOMContentLoaded", function () {
        (document.head || document.body || document.documentElement).appendChild(style);
      });
    }
  }

  chrome.storage.local.get(null, function (settings) {
    if (!settings) settings = {};
    var hostname = window.location.hostname;
    var wl = settings.whitelist || [];
    if (isWhitelisted(hostname, wl)) return;
    applyCosmeticFilters(settings);
    applyMouseUnlock(settings);
  });
})();
