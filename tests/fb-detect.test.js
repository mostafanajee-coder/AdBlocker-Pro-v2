/* ============================================================================
 *  fb-detect.test.js
 *
 *  Reproduces the obfuscation techniques Facebook actually uses on its
 *  "Sponsored" label and asserts that the detector still reads it correctly.
 *
 *      node tests/fb-detect.test.js
 * ========================================================================== */

"use strict";

const path = require("path");
const D = require(path.join(__dirname, "..", "fb-detect.js"));
const { el, clipBox, txt, hiddenTxt, makeEnv } = require("./fake-dom.js");

const env = makeEnv();

let passed = 0, failed = 0;
const failures = [];

function check(name, got, want) {
  const ok = got === want;
  ok ? passed++ : failed++;
  if (!ok) failures.push({ name, got, want });
  console.log(
    (ok ? "  PASS  " : "  FAIL  ") + name.padEnd(52) +
    (ok ? "" : `\n          got  ${JSON.stringify(got)}\n          want ${JSON.stringify(want)}`)
  );
}

function section(t) { console.log("\n" + t + "\n" + "-".repeat(t.length)); }

/* ==========================================================================
 * 1. Clean label — the easy baseline
 * ======================================================================== */

section("1. Plain label, no obfuscation");
{
  const span = el("span").append(txt("Sponsored", 100, 50, 60, 12));
  check("reads a plain English label", D.readLabel(span, env), "sponsored");
  check("matches SPONSORED", D.matchesAny(D.readLabel(span, env), D.SPONSORED), true);

  const spanAd = el("span").append(txt("Ad", 100, 50, 20, 12));
  check("reads short 'Ad' label", D.readLabel(spanAd, env), "ad");
  check("'Ad' matches SPONSORED", D.matchesAny(D.readLabel(spanAd, env), D.SPONSORED), true);

  const spanIlan = el("span").append(txt("إعلان", 100, 50, 30, 12));
  check("reads Arabic 'إعلان' label", D.readLabel(spanIlan, env), "اعلان");
  check("'إعلان' matches SPONSORED", D.matchesAny(D.readLabel(spanIlan, env), D.SPONSORED), true);
}

/* ==========================================================================
 * 2. Decoy characters hidden with display:none
 *    DOM text: "SXpoYnsZored"  — visible: "Sponsored"
 * ======================================================================== */

section("2. Decoy letters hidden with display:none");
{
  const span = el("span").append(
    txt("S", 100, 50, 7, 12),
    el("i", { display: "none" }).append(hiddenTxt("X")),
    txt("po", 107, 50, 14, 12),
    el("i", { display: "none" }).append(hiddenTxt("Y")),
    txt("ns", 121, 50, 13, 12),
    el("i", { display: "none" }).append(hiddenTxt("Z")),
    txt("ored", 134, 50, 26, 12)
  );

  check("raw textContent is corrupted", span.textContent, "SXpoYnsZored");
  check("visible reconstruction is clean", D.readLabel(span, env), "sponsored");
  check("still matches SPONSORED", D.matchesAny(D.readLabel(span, env), D.SPONSORED), true);
}

/* ==========================================================================
 * 3. Scrambled DOM order, repaired visually by flexbox `order`
 *    DOM order: "redSponso"  — visual order: "Sponsored"
 * ======================================================================== */

section("3. Scrambled DOM order, correct visual order");
{
  const span = el("span").append(
    txt("red", 149, 50, 20, 12),      // appears LAST on screen
    txt("Sponso", 100, 50, 49, 12)    // appears FIRST on screen
  );

  check("raw textContent is out of order", span.textContent, "redSponso");
  check("x-sorting restores reading order", D.readLabel(span, env), "sponsored");
}

/* ==========================================================================
 * 4. Off-screen and clipped decoys
 * ======================================================================== */

section("4. Off-screen / clipped / zero-opacity decoys");
{
  const span = el("span").append(
    txt("Spon", 100, 50, 30, 12),
    el("i", { position: "absolute", left: "-9999px" }).append(txt("QQ", -9999, 50, 10, 12)),
    el("i", { clip: "rect(0px, 0px, 0px, 0px)", position: "absolute" }).append(txt("WW", 0, 0, 0, 0)),
    el("i", { opacity: "0" }).append(txt("EE", 130, 50, 10, 12)),
    el("i", { fontSize: "0px" }).append(txt("RR", 130, 50, 0, 0)),
    el("i", { visibility: "hidden" }).append(txt("TT", 130, 50, 10, 12)),
    txt("sored", 130, 50, 33, 12)
  );

  check("raw is heavily polluted", span.textContent, "SponQQWWEERRTTsored");
  check("all decoy styles are stripped", D.readLabel(span, env), "sponsored");
}

/* ==========================================================================
 * 5. Arabic with diacritics, tatweel, and zero-width joiners
 * ======================================================================== */

section("5. Arabic label variants");
{
  const a = el("span").append(txt("مُموَّل", 200, 50, 40, 14));
  check("diacritics normalized", D.readLabel(a, env), "ممول");
  check("matches SPONSORED", D.matchesAny(D.readLabel(a, env), D.SPONSORED), true);

  // RTL: the FIRST character sits at the LARGEST x. DOM order is also
  // scrambled, and a decoy is hidden in the middle.
  const b = el("span").append(
    txt("مُ", 230, 50, 10, 14),                              // reads 1st
    el("i", { display: "none" }).append(hiddenTxt("ق")),     // decoy
    txt("مو", 218, 50, 12, 14),                              // reads 2nd
    txt("َّل", 206, 50, 12, 14)                               // reads 3rd
  );
  check("split Arabic with decoy (RTL order)",
        D.matchesAny(D.readLabel(b, env), D.SPONSORED), true);
  check("RTL reconstruction is exact", D.readLabel(b, env), "ممول");

  // A Latin label must still sort left-to-right after the RTL change
  const e = el("span").append(
    txt("red", 149, 50, 20, 12),
    txt("Sponso", 100, 50, 49, 12)
  );
  check("LTR unaffected by RTL handling", D.readLabel(e, env), "sponsored");

  const c = el("span").append(txt("م​م‌و‍ل", 200, 50, 40, 14));
  check("zero-width chars removed", D.readLabel(c, env), "ممول");

  const d = el("span").append(txt("بِرعاية", 200, 50, 40, 14));
  check("برعاية matches", D.matchesAny(D.readLabel(d, env), D.SPONSORED), true);
}

/* ==========================================================================
 * 6. False positives — the expensive kind of mistake
 * ======================================================================== */

section("6. Must NOT match");
{
  const names = [
    "Ahmed Ali",
    "منشور عادي من صديق",
    "Sponsors of the event were announced today",
    "برنامج رعاية الأيتام",
    "My sponsored swim raised money",
    "Add friend",
    "Ad Center",
    "Ads Manager",
    "Admin",
    "Address",
    "Add account",
    ""
  ];

  for (const n of names) {
    const span = el("span").append(txt(n, 100, 50, n.length * 7, 12));
    check(`rejects: ${JSON.stringify(n.slice(0, 34))}`,
          D.matchesAny(D.readLabel(span, env), D.SPONSORED), false);
  }
}

/* ==========================================================================
 * 7. Label followed by a timestamp — real posts look like this
 * ======================================================================== */

section("7. Label with trailing separator / timestamp");
{
  const a = el("span").append(txt("Sponsored · 3h", 100, 50, 90, 12));
  check("'Sponsored · 3h' matches", D.matchesAny(D.readLabel(a, env), D.SPONSORED), true);

  const b = el("span").append(txt("مُموَّل · ٥ س", 100, 50, 90, 12));
  check("'مُموَّل · ٥ س' matches", D.matchesAny(D.readLabel(b, env), D.SPONSORED), true);

  const c = el("span").append(txt("Ad · 3h", 100, 50, 50, 12));
  check("'Ad · 3h' matches", D.matchesAny(D.readLabel(c, env), D.SPONSORED), true);

  const d = el("span").append(txt("إعلان · ٣ س", 100, 50, 60, 12));
  check("'إعلان · ٣ س' matches", D.matchesAny(D.readLabel(d, env), D.SPONSORED), true);
}

/* ==========================================================================
 * 8. Multi-line reconstruction (y before x)
 * ======================================================================== */

section("8. Two-line label");
{
  const span = el("span").append(
    txt("sored", 100, 70, 32, 12),    // second line, but first in the DOM
    txt("Spon", 100, 50, 28, 12)      // first line
  );
  check("sorts by line, then by column", D.readLabel(span, env), "sponsored");
}

/* ==========================================================================
 * 9. THE REAL THING — captured live from facebook.com, August 2026
 *
 *    Facebook interleaves U+034F COMBINING GRAPHEME JOINER between every
 *    letter, each in its own zero-width text node. Verified on the live
 *    site by dumping the geometry of a "Learn more" CTA:
 *
 *        "L" x=575 w=7.3        "͏" x=582 w=0
 *        "e" x=582 w=8          "a"      x=590 w=7.8
 *        "͏" x=590 w=0     "r"      x=598 w=5.6
 *
 *    This reproduces that exact pattern for "Sponsored".
 * ======================================================================== */

section("9. Live-captured U+034F joiner obfuscation");
{
  const CGJ = "͏";
  const letters = ["S", "p", "o", "n", "s", "o", "r", "e", "d"];
  const widths  = [7.3, 8.5, 9, 8.8, 6.5, 9, 5.6, 8, 8.6];

  const span = el("span");
  let x = 100;
  for (let i = 0; i < letters.length; i++) {
    span.append(txt(letters[i], x, 50, widths[i], 20));
    x += widths[i];
    // the joiner: a real text node with a real rect of width ZERO
    span.append(txt(CGJ, x, 50, 0, 20));
  }

  const raw = span.textContent;
  check("raw contains the joiners", raw.includes(CGJ), true);
  check("raw length is inflated", raw.length, 18);
  check("visible text is clean", D.readLabel(span, env), "sponsored");
  check("matches SPONSORED", D.matchesAny(D.readLabel(span, env), D.SPONSORED), true);

  // Even if a rect measurement were missed, normalization must still cope.
  check("norm strips U+034F directly", D.norm("S͏p͏on͏sored"), "sponsored");
  check("norm strips it from Arabic too", D.norm("م͏م͏و͏ل"), "ممول");
}

/* ==========================================================================
 * 10. REGRESSION — overflow:hidden decoys
 *
 *     Captured from a real feed: the detector returned
 *
 *       "sponsoredontrsdseop05fu935tca120a1t285fmc58hl8c598gl632gt000"
 *
 *     The label reconstructed correctly, then a pile of decoy letters was
 *     appended. Those decoys have a real position AND a real size, so they
 *     pass every display / visibility / opacity test. What hides them is an
 *     ancestor with overflow:hidden whose box they fall outside of.
 *
 *     The inflated string then failed the length check and the ad survived.
 * ======================================================================== */

section("10. overflow:hidden decoys (live regression)");
{
  // Clip window: 100..180 horizontally, 50..70 vertically
  const wrapper = clipBox({ overflow: "hidden" }, { x: 100, y: 50, w: 80, h: 20 });

  // The real label, inside the clip window
  wrapper.append(txt("Sponsored", 100, 50, 62, 16));

  // Decoys: full size, fully "visible" by every CSS test — but outside the box
  wrapper.append(txt("ontrsdseop", 400, 50, 70, 16));
  wrapper.append(txt("05fu935tca120a1t285", 100, 300, 130, 16));
  wrapper.append(txt("fmc58hl8c598gl632gt000", 900, 800, 150, 16));

  const raw = wrapper.textContent;
  check("raw reproduces the reported string",
        raw, "Sponsoredontrsdseop05fu935tca120a1t285fmc58hl8c598gl632gt000");
  check("clipped decoys are dropped", D.readLabel(wrapper, env), "sponsored");
  check("now matches SPONSORED", D.matchesAny(D.readLabel(wrapper, env), D.SPONSORED), true);

  // Text that overlaps the clip box must still be read
  const ok = clipBox({ overflow: "hidden" }, { x: 100, y: 50, w: 200, h: 20 });
  ok.append(txt("Sponsored", 100, 50, 62, 16));
  check("unclipped text is kept", D.readLabel(ok, env), "sponsored");

  // Transparent text is unreadable too
  const t = el("span").append(
    txt("Spon", 100, 50, 28, 16),
    el("i", { color: "rgba(0, 0, 0, 0)" }).append(txt("XYZ", 128, 50, 20, 16)),
    txt("sored", 148, 50, 34, 16)
  );
  check("transparent decoys are dropped", D.readLabel(t, env), "sponsored");
}

/* ==========================================================================
 * 11. REGRESSION — off-canvas screen-reader text
 *
 *     Live finding: Facebook parks accessibility and template text at
 *     coordinates around x=-9980, y=-10001. Those nodes are not display:none
 *     and their ancestors are not always positioned, so the style checks pass
 *     them through. The detector then read a container full of repeated
 *     "Facebook" strings as visible text and blocked the wrong element.
 * ======================================================================== */

section("11. off-canvas text is not readable");
{
  const span = el("span").append(
    txt("Sponsored", 100, 50, 62, 16),
    txt("FacebookFacebookFacebook", -9980, -10001, 190, 16)
  );
  check("off-canvas text is dropped", D.readLabel(span, env), "sponsored");
  check("label still matches", D.matchesAny(D.readLabel(span, env), D.SPONSORED), true);

  // A container that holds ONLY off-canvas text must read as empty,
  // so it can never be mistaken for a label.
  const ghost = el("span").append(txt("Facebook", -9980, -10001, 63, 16));
  check("pure off-canvas container reads empty", D.readLabel(ghost, env), "");

  // Content below the fold has a large positive y and must still be read.
  const below = el("span").append(txt("Sponsored", 100, 4200, 62, 16));
  check("below-the-fold text is kept", D.readLabel(below, env), "sponsored");

  // Slightly negative (partially scrolled past) must still be read.
  const partial = el("span").append(txt("Sponsored", 100, -80, 62, 16));
  check("partially scrolled text is kept", D.readLabel(partial, env), "sponsored");
}

/* ==========================================================================
 * 12. Suggested-post labels
 * ======================================================================== */

section("9. Suggested-post labels");
{
  const a = el("span").append(txt("Suggested for you", 100, 50, 110, 12));
  check("English suggested", D.matchesAny(D.readLabel(a, env), D.SUGGESTED), true);
  check("suggested is not sponsored", D.matchesAny(D.readLabel(a, env), D.SPONSORED), false);

  const b = el("span").append(txt("مقترح لك", 100, 50, 60, 12));
  check("Arabic suggested", D.matchesAny(D.readLabel(b, env), D.SUGGESTED), true);
}

/* ==========================================================================
 * 12. SVG <use xlink:href="#SvgId"> label obfuscation (live Facebook Aug 2026)
 * ======================================================================== */

section("12. SVG <use> label obfuscation");
{
  const targetText = el("text", {}, { id: "SvgT299" }).append(hiddenTxt("Sponsored"));
  const envSvg = makeEnv({ SvgT299: targetText });

  const useTag = el("use", {}, { "xlink:href": "#SvgT299" });
  const svgEl = el("svg").append(useTag);
  const labelWrapper = el("span").append(svgEl);

  check("resolves SVG <use> referenced target text", D.readLabel(labelWrapper, envSvg), "sponsored");
  check("SVG <use> label matches SPONSORED", D.matchesAny(D.readLabel(labelWrapper, envSvg), D.SPONSORED), true);
}

/* ==========================================================================
 * Summary
 * ======================================================================== */

console.log("\n" + "=".repeat(64));
console.log(`  ${passed} passed, ${failed} failed`);
console.log("=".repeat(64));

if (failed) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f.name}: got ${JSON.stringify(f.got)}, want ${JSON.stringify(f.want)}`);
  process.exit(1);
}
process.exit(0);
