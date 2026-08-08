var currentHostname = "";

function getCurrentTab(cb) {
  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    if (tabs && tabs[0]) cb(tabs[0]);
  });
}

function init() {
  getCurrentTab(function (tab) {
    if (!tab || !tab.url) {
      document.getElementById("statusText").textContent = "No tab detected";
      return;
    }
    try {
      currentHostname = new URL(tab.url).hostname;
    } catch (_) {
      document.getElementById("statusText").textContent = "Invalid URL";
      return;
    }

    chrome.runtime.sendMessage({ type: "getSettings" }, function (settings) {
      if (!settings) return;
      var wl = settings.whitelist || [];
      var i, whitelisted = false;
      var parts = currentHostname.split(".");
      for (i = 0; i < parts.length - 1; i++) {
        if (wl.indexOf(parts.slice(i).join(".")) !== -1) {
          whitelisted = true;
          break;
        }
      }

      var keys = [
        "adBlock", "strictTracking", "antiAdblock", "mouseUnlock",
        "useFilterLists", "ytSkip", "ytHide", "ytCurtain",
        "fbSponsored", "fbSidebar", "fbSuggested", "fbReels", "fbDebug"
      ];
      for (var k = 0; k < keys.length; k++) {
        var box = document.getElementById(keys[k]);
        if (box) box.checked = settings[keys[k]] === true;
      }

      var counter = document.getElementById("counter");
      if (counter) counter.textContent = (settings.totalBlocked || 0) + " blocked";

      renderFilterStat(settings.filterReport);

      var btn = document.getElementById("whitelistBtn");
      if (whitelisted) {
        btn.textContent = "Remove from whitelist";
        btn.classList.add("active");
      } else {
        btn.textContent = "Whitelist this site";
        btn.classList.remove("active");
      }

      document.getElementById("statusText").textContent = whitelisted
        ? currentHostname + " (whitelisted)"
        : currentHostname;
    });
  });
}

function bindToggle(id, settingKey) {
  var el = document.getElementById(id);
  if (!el) return;
  el.addEventListener("change", function () {
    var update = {};
    update[settingKey] = this.checked;
    chrome.runtime.sendMessage({ type: "updateSettings", settings: update });
  });
}

[
  "adBlock", "strictTracking", "antiAdblock", "mouseUnlock",
  "useFilterLists", "ytSkip", "ytHide", "ytCurtain",
  "fbSponsored", "fbSidebar", "fbSuggested", "fbReels", "fbDebug"
].forEach(function (k) { bindToggle(k, k); });

/* ---------------- filter lists ---------------- */

function renderFilterStat(report) {
  var el = document.getElementById("filterStat");
  if (!el) return;

  if (!report || !report.rules) {
    el.textContent = "Not built yet — press update";
    return;
  }

  var when = new Date(report.at);
  var ok = (report.sources || []).filter(function (s) { return s.ok; }).length;
  var html = "<b>" + report.rules.toLocaleString() + "</b> network rules · <b>" +
             (report.selectors || 0).toLocaleString() + "</b> hiding rules<br>" +
             ok + " list(s) · " + when.toLocaleDateString();
  if (report.truncated) html += "<br>(capped at Chrome's 30,000 limit)";
  el.innerHTML = html;
}

var rebuildBtn = document.getElementById("rebuildBtn");
if (rebuildBtn) {
  rebuildBtn.addEventListener("click", function () {
    rebuildBtn.disabled = true;
    rebuildBtn.textContent = "Downloading…";

    chrome.runtime.sendMessage({ type: "rebuildFilters" }, function (res) {
      rebuildBtn.disabled = false;
      if (res && res.ok) {
        rebuildBtn.textContent = "Update filter lists";
        renderFilterStat(res.report);
      } else {
        rebuildBtn.textContent = "Failed — retry";
        var el = document.getElementById("filterStat");
        if (el) el.textContent = (res && res.error) || "Unknown error";
      }
    });
  });
}

chrome.runtime.onMessage.addListener(function (msg) {
  if (msg && msg.type === "filterProgress") {
    var el = document.getElementById("filterStat");
    if (el) el.textContent = msg.msg;
  }
});

document.getElementById("whitelistBtn").addEventListener("click", function () {
  if (!currentHostname) return;
  chrome.runtime.sendMessage({
    type: "toggleWhitelist",
    hostname: currentHostname
  }, function (resp) {
    if (resp && resp.whitelist) {
      var wl = resp.whitelist;
      var i, whitelisted = false;
      var parts = currentHostname.split(".");
      for (i = 0; i < parts.length - 1; i++) {
        if (wl.indexOf(parts.slice(i).join(".")) !== -1) {
          whitelisted = true;
          break;
        }
      }
      var btn = document.getElementById("whitelistBtn");
      if (whitelisted) {
        btn.textContent = "Remove from whitelist";
        btn.classList.add("active");
        document.getElementById("statusText").textContent = currentHostname + " (whitelisted)";
      } else {
        btn.textContent = "Whitelist this site";
        btn.classList.remove("active");
        document.getElementById("statusText").textContent = currentHostname;
      }
    }
  });
});

init();
