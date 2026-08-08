/* ============================================================================
 *  filters.js — filter-list engine for Ad Blocker Pro
 *
 *  THE PROBLEM THIS SOLVES
 *  -----------------------
 *  rules_ads.json ships 23 hand-written rules. Real ad blockers work from
 *  community filter lists containing tens of thousands of entries that are
 *  updated daily. Under Manifest V3 we cannot run uBlock Origin's engine, but
 *  we CAN convert those lists into declarativeNetRequest DYNAMIC rules, which
 *  Chrome evaluates natively — no per-request JavaScript, no MV3 restriction.
 *
 *  Chrome's ceiling is 30,000 dynamic rules per extension, so this module
 *  converts what it can, prioritises the highest-value patterns, and stops
 *  cleanly at the limit instead of failing.
 *
 *  WHAT IT CONVERTS
 *  ----------------
 *      ||example.com^                -> block requests to that domain
 *      ||example.com^$third-party    -> block only as a third party
 *      ||example.com^$script,image   -> block only those resource types
 *      @@||example.com^              -> exception (allow) rule
 *      /banner-ads/                  -> substring match
 *
 *  Cosmetic rules (##.ad-banner) are NOT network rules; they are extracted
 *  separately and handed to the content script as CSS.
 * ========================================================================== */

"use strict";

const FILTERS = {
  MAX_DYNAMIC_RULES: 29000,      // Chrome's cap is 30,000 — leave headroom
  RULE_ID_BASE: 100000,          // stay clear of the static ruleset IDs
  STORAGE_KEY: "filterLists",
  CSS_KEY: "cosmeticCss",

  /* Community lists, ordered by value-per-rule. */
  SOURCES: [
    { id: "easylist",     name: "EasyList",           url: "https://easylist.to/easylist/easylist.txt",             enabled: true },
    { id: "easyprivacy",  name: "EasyPrivacy",        url: "https://easylist.to/easylist/easyprivacy.txt",          enabled: true },
    { id: "adguard-base", name: "AdGuard Base",       url: "https://filters.adtidy.org/extension/chromium/filters/2.txt", enabled: false },
    { id: "arabic",       name: "AdGuard Arabic",     url: "https://filters.adtidy.org/extension/chromium/filters/25.txt", enabled: true },
    { id: "annoyances",   name: "Fanboy Annoyances",  url: "https://secure.fanboy.co.nz/fanboy-annoyance.txt",      enabled: false }
  ],

  /* Map AdBlock Plus option names onto Chrome resource types. */
  TYPE_MAP: {
    script: "script",
    image: "image",
    stylesheet: "stylesheet",
    object: "object",
    xmlhttprequest: "xmlhttprequest",
    subdocument: "sub_frame",
    document: "main_frame",
    media: "media",
    font: "font",
    websocket: "websocket",
    ping: "ping",
    other: "other"
  },

  /* ---------------------------------------------------------------- *
   * Parsing                                                           *
   * ---------------------------------------------------------------- */

  /**
   * Convert one filter line into a DNR rule, or null when unsupported.
   * @returns {null | {rule: object, isException: boolean}}
   */
  parseLine(line, id) {
    if (!line) return null;
    let s = line.trim();

    // comments, metadata, empty
    if (!s || s[0] === "!" || s[0] === "[" || s.startsWith("# ")) return null;

    // cosmetic rules are handled elsewhere
    if (s.includes("##") || s.includes("#@#") || s.includes("#?#") || s.includes("#$#")) return null;

    const isException = s.startsWith("@@");
    if (isException) s = s.slice(2);

    // split off $options
    let optionsPart = "";
    const dollar = s.lastIndexOf("$");
    if (dollar > 0 && !s.slice(dollar).includes("/")) {
      optionsPart = s.slice(dollar + 1);
      s = s.slice(0, dollar);
    }

    if (!s) return null;

    // Slash-delimited filters. In ABP syntax these are regular expressions,
    // but a large share of EasyList entries are plain path fragments such as
    // /banner-ads/ with no metacharacters at all. Those convert cleanly into
    // a substring urlFilter; anything with real regex syntax is dropped,
    // because Chrome's regexFilter support is narrower than RE2 and a bad
    // rule makes the whole batch fail to install.
    if (s.length > 2 && s.startsWith("/") && s.endsWith("/")) {
      const inner = s.slice(1, -1);
      if (/[\\^$.|?*+()[\]{}]/.test(inner)) return null;   // genuine regex
      if (inner.length < 3) return null;
      s = inner;
    }

    const condition = {};
    const resourceTypes = [];
    let domains = null;
    let excludedDomains = null;

    if (optionsPart) {
      for (const rawOpt of optionsPart.split(",")) {
        const opt = rawOpt.trim();
        if (!opt) continue;

        if (opt === "third-party" || opt === "3p") { condition.domainType = "thirdParty"; continue; }
        if (opt === "~third-party" || opt === "1p") { condition.domainType = "firstParty"; continue; }

        if (opt.startsWith("domain=")) {
          const list = opt.slice(7).split("|");
          const inc = [], exc = [];
          for (const d of list) {
            if (!d) continue;
            if (d[0] === "~") exc.push(d.slice(1)); else inc.push(d);
          }
          if (inc.length) domains = inc;
          if (exc.length) excludedDomains = exc;
          continue;
        }

        // unsupported behavioural options: bail out rather than guess
        if (opt === "popup" || opt === "elemhide" || opt === "generichide" ||
            opt === "genericblock" || opt === "csp" || opt.startsWith("csp=") ||
            opt.startsWith("rewrite=") || opt === "badfilter" || opt === "important" ||
            opt.startsWith("redirect")) {
          return null;
        }

        const neg = opt[0] === "~";
        const base = neg ? opt.slice(1) : opt;
        const mapped = FILTERS.TYPE_MAP[base];
        if (mapped && !neg) resourceTypes.push(mapped);
      }
    }

    condition.urlFilter = s;
    if (resourceTypes.length) condition.resourceTypes = resourceTypes;
    if (domains) condition.initiatorDomains = domains;
    if (excludedDomains) condition.excludedInitiatorDomains = excludedDomains;

    // A urlFilter that is only punctuation matches far too much
    if (!/[a-z0-9]/i.test(condition.urlFilter)) return null;
    if (condition.urlFilter.length < 4) return null;

    return {
      isException,
      rule: {
        id,
        priority: isException ? 2 : 1,
        action: { type: isException ? "allow" : "block" },
        condition
      }
    };
  },

  /** Pull cosmetic (element-hiding) selectors out of a list. */
  parseCosmetic(text, maxSelectors) {
    const generic = [];
    let count = 0;

    for (const line of text.split("\n")) {
      const s = line.trim();
      if (!s || s[0] === "!") continue;

      const idx = s.indexOf("##");
      if (idx === -1) continue;
      if (idx > 0) continue;                 // domain-specific: skip, keep it cheap

      const sel = s.slice(idx + 2).trim();
      if (!sel || sel.startsWith("+js") || sel.startsWith("^")) continue;
      if (sel.includes(":has(") || sel.includes(":not(:") ||
          sel.includes(":matches-css") || sel.includes(":xpath") ||
          sel.includes(":upward") || sel.includes(":style")) continue;

      generic.push(sel);
      if (++count >= maxSelectors) break;
    }
    return generic;
  },

  /* ---------------------------------------------------------------- *
   * Fetch + build                                                     *
   * ---------------------------------------------------------------- */

  async fetchList(url) {
    const res = await fetch(url, { cache: "no-cache" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return res.text();
  },

  /**
   * Download every enabled list, convert, and install as dynamic rules.
   * @returns {Promise<object>} report
   */
  async rebuild(onProgress) {
    const stored = await chrome.storage.local.get([FILTERS.STORAGE_KEY]);
    const enabledIds = stored[FILTERS.STORAGE_KEY] ||
                       FILTERS.SOURCES.filter((s) => s.enabled).map((s) => s.id);

    const report = { sources: [], rules: 0, selectors: 0, truncated: false, at: Date.now() };

    const rules = [];
    const exceptions = [];
    const selectors = new Set();
    let nextId = FILTERS.RULE_ID_BASE;
    let seen = new Set();

    for (const src of FILTERS.SOURCES) {
      if (!enabledIds.includes(src.id)) continue;
      if (onProgress) onProgress("Fetching " + src.name + "…");

      let text;
      try {
        text = await FILTERS.fetchList(src.url);
      } catch (e) {
        report.sources.push({ id: src.id, name: src.name, ok: false, error: e.message, rules: 0 });
        continue;
      }

      let made = 0;
      for (const line of text.split("\n")) {
        if (rules.length + exceptions.length >= FILTERS.MAX_DYNAMIC_RULES) {
          report.truncated = true;
          break;
        }

        const key = line.trim();
        if (!key || seen.has(key)) continue;
        seen.add(key);

        const parsed = FILTERS.parseLine(key, nextId);
        if (!parsed) continue;

        nextId++;
        made++;
        (parsed.isException ? exceptions : rules).push(parsed.rule);
      }

      for (const sel of FILTERS.parseCosmetic(text, 4000)) selectors.add(sel);

      report.sources.push({ id: src.id, name: src.name, ok: true, rules: made });
      if (report.truncated) break;
    }

    // Exceptions carry higher priority, so install them first.
    const all = exceptions.concat(rules);
    report.rules = all.length;
    report.selectors = selectors.size;

    if (onProgress) onProgress("Installing " + all.length.toLocaleString() + " rules…");

    // Replace the whole dynamic set atomically.
    const existing = await chrome.declarativeNetRequest.getDynamicRules();
    const removeIds = existing.map((r) => r.id);

    // Chrome rejects oversized single calls; install in batches.
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: removeIds,
      addRules: []
    });

    const BATCH = 4000;
    for (let i = 0; i < all.length; i += BATCH) {
      await chrome.declarativeNetRequest.updateDynamicRules({
        addRules: all.slice(i, i + BATCH)
      });
      if (onProgress) onProgress("Installing " + Math.min(i + BATCH, all.length).toLocaleString() +
                                 " / " + all.length.toLocaleString());
    }

    await chrome.storage.local.set({
      filterReport: report,
      [FILTERS.CSS_KEY]: Array.from(selectors).slice(0, 4000)
    });

    return report;
  },

  /** How many dynamic rules are currently live. */
  async count() {
    try {
      const r = await chrome.declarativeNetRequest.getDynamicRules();
      return r.length;
    } catch (_) { return 0; }
  },

  async clear() {
    const existing = await chrome.declarativeNetRequest.getDynamicRules();
    if (existing.length) {
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: existing.map((r) => r.id)
      });
    }
    await chrome.storage.local.set({ filterReport: null, [FILTERS.CSS_KEY]: [] });
  }
};

if (typeof module !== "undefined" && module.exports) module.exports = { FILTERS };
if (typeof self !== "undefined") self.FILTERS = FILTERS;
