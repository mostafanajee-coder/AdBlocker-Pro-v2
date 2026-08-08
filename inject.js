(function () {
  // 1. Mock Ads Variables
  try {
    var mockAds = [];
    mockAds.push = function () {};
    mockAds.loaded = true;
    mockAds.length = 5;
    Object.defineProperty(window, "adsbygoogle", { value: mockAds, writable: true, configurable: true });
    window.canRunAds = true;
    window.show_ads = function () {};
    window.snack = { isAdBlockerPresent: false };
    window.fuckAdBlock = { onDetected: function(){return this;}, onNotDetected: function(cb){setTimeout(cb,10);return this;}, on: function(is,cb){if(!is)setTimeout(cb,10);return this;}, clearEvent: function(){return this;} };
    window.BlockAdBlock = window.fuckAdBlock;
    window.google_ad_client = "ca-pub-0000000000000000";
    window.google_ad_status = 1;
  } catch (_) {}

  // 2. Intercept Auto-Redirects
  try {
    var origReplace = window.location.replace;
    window.location.replace = function (url) {
      if (/adblock|detect|warning|block|safelink/i.test(url)) return;
      return origReplace.apply(this, arguments);
    };
    var origAssign = window.location.assign;
    window.location.assign = function (url) {
      if (/adblock|detect|warning|block|safelink/i.test(url)) return;
      return origAssign.apply(this, arguments);
    };
  } catch (_) {}

  // 3. GOD MODE: Defeat Dimension Checks
  try {
    const attrs = ['offsetHeight', 'offsetWidth', 'clientHeight', 'clientWidth'];
    attrs.forEach(function(attr) {
      const orig = Object.getOwnPropertyDescriptor(HTMLElement.prototype, attr);
      if (orig) {
        Object.defineProperty(HTMLElement.prototype, attr, {
          get: function () {
            const val = orig.get.call(this);
            if (val === 0) {
              const c = (this.className || "").toString().toLowerCase();
              const i = (this.id || "").toString().toLowerCase();
              if (c.indexOf("ad") > -1 || i.indexOf("ad") > -1 || this.tagName === "INS") {
                return 1;
              }
            }
            return val;
          },
          configurable: true
        });
      }
    });
  } catch (_) {}

  // 4. GOD MODE: Defeat CSS Visibility Checks (ENHANCED)
  try {
    const origGetComputedStyle = window.getComputedStyle;
    window.getComputedStyle = function(elem, pseudoElt) {
      const style = origGetComputedStyle.call(window, elem, pseudoElt);
      if (!style) return style;

      const c = (elem.className || "").toString().toLowerCase();
      const i = (elem.id || "").toString().toLowerCase();

      if (c.indexOf("ad") > -1 || i.indexOf("ad") > -1 || elem.tagName === "INS") {
        return new Proxy(style, {
          get: function(target, prop) {
            const val = target[prop];
            if (typeof val === 'function') {
              if (prop === 'getPropertyValue') {
                return function(p) {
                  if (p === 'display' && target.display === 'none') return 'block';
                  if (p === 'visibility' && target.visibility === 'hidden') return 'visible';
                  return target.getPropertyValue(p);
                };
              }
              return val.bind(target);
            }
            if (prop === 'display' && val === 'none') return 'block';
            if (prop === 'visibility' && val === 'hidden') return 'visible';
            return val;
          }
        });
      }
      return style;
    };
  } catch (_) {}

  // 5. GOD MODE: Network Error Trap Defeater
  try {
    window.addEventListener('error', function(e) {
      const target = e.target;
      if (target && (target.tagName === 'SCRIPT' || target.tagName === 'IMG' || target.tagName === 'IFRAME')) {
        const src = target.src || target.href || '';
        if (/adsbygoogle|doubleclick|adblock|detect|pagead|adserver|safelink/i.test(src)) {
          e.stopPropagation();
          e.stopImmediatePropagation();
          e.preventDefault();
          setTimeout(function() {
            try { target.dispatchEvent(new Event('load')); } catch (_) {}
          }, 10);
        }
      }
    }, true);
  } catch (_) {}
})();
