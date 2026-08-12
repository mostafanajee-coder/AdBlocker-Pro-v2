/* ============================================================================
 *  fake-dom.js — a minimal DOM with LAYOUT, built for these tests
 *
 *  Why not jsdom? jsdom implements the DOM API but performs no layout, so
 *  getBoundingClientRect() returns all zeros for every element. The whole
 *  point of visibleText() is that it reads real on-screen geometry — under
 *  jsdom every fragment would measure zero and the test would prove nothing.
 *
 *  So this file models exactly the three things the detector depends on:
 *      1. a tree of elements and text nodes
 *      2. computed styles, inherited down the tree
 *      3. rectangles for text nodes, driven by explicit x/y/w/h
 *
 *  That lets a test place a decoy span off-screen, or give it display:none,
 *  or scramble the DOM order while keeping the visual order intact — exactly
 *  what Facebook does — and assert on the outcome.
 * ========================================================================== */

"use strict";

const SHOW_TEXT = 4;

class FakeNode {
  constructor(type) {
    this.nodeType = type;
    this.childNodes = [];
    this.parentElement = null;
  }
}

class FakeText extends FakeNode {
  constructor(text, rect) {
    super(3);
    this.textContent = text;
    // rect: {x, y, w, h} — omit or pass zeros to simulate invisible text
    this.rect = rect || { x: 0, y: 0, w: 0, h: 0 };
  }
}

class FakeElement extends FakeNode {
  constructor(tag, style, box) {
    super(1);
    this.tagName = (tag || "div").toUpperCase();
    this.style = style || {};
    this.attributes = {};
    // Only needed for elements that clip (overflow:hidden) — the test asserts
    // that fragments outside this box are treated as invisible.
    this.box = box || null;
  }

  getBoundingClientRect() {
    const b = this.box || { x: 0, y: 0, w: 0, h: 0 };
    return { left: b.x, top: b.y, width: b.w, height: b.h,
             right: b.x + b.w, bottom: b.y + b.h };
  }

  append(...kids) {
    for (const k of kids) {
      k.parentElement = this;
      this.childNodes.push(k);
    }
    return this;
  }

  get textContent() {
    let s = "";
    for (const c of this.childNodes) s += c.textContent;
    return s;
  }

  getAttribute(k) { return this.attributes[k] !== undefined ? this.attributes[k] : null; }
  setAttribute(k, v) { this.attributes[k] = String(v); }

  querySelector(tag) {
    const res = this.querySelectorAll(tag);
    return res.length > 0 ? res[0] : null;
  }

  querySelectorAll(tag) {
    const out = [];
    const targetTag = tag ? tag.toUpperCase() : null;
    (function walk(n) {
      for (const c of n.childNodes) {
        if (c.nodeType === 1) {
          if (!targetTag || c.tagName === targetTag) out.push(c);
          walk(c);
        }
      }
    })(this);
    return out;
  }
}

/* --- factories -------------------------------------------------------- */

const el  = (tag, style, attrs) => {
  const e = new FakeElement(tag, style);
  if (attrs) {
    for (const k in attrs) e.setAttribute(k, attrs[k]);
  }
  return e;
};
const clipBox = (style, box) => new FakeElement("div", style, box);
const txt = (text, x, y, w, h) =>
  new FakeText(text, { x: x || 0, y: y || 0, w: w === undefined ? 8 : w, h: h === undefined ? 12 : h });

/** A text fragment that is present in the DOM but invisible on screen. */
const hiddenTxt = (text) => new FakeText(text, { x: 0, y: 0, w: 0, h: 0 });

/* --- the environment handed to ABPDetect ------------------------------ */

function makeEnv(elementsById) {
  const registry = elementsById || {};
  const doc = {
    getElementById(id) {
      return registry[id] || null;
    },

    createTreeWalker(root, whatToShow) {
      const out = [];
      (function walk(n) {
        for (const c of n.childNodes) {
          if (c.nodeType === 3 && (whatToShow & SHOW_TEXT)) out.push(c);
          if (c.nodeType === 1) walk(c);
        }
      })(root);

      let i = 0;
      return { nextNode: () => (i < out.length ? out[i++] : null) };
    },

    createRange() {
      let node = null;
      return {
        selectNodeContents(n) { node = n; },
        getBoundingClientRect() {
          if (!node || !node.rect) return { left: 0, top: 0, width: 0, height: 0 };
          const r = node.rect;
          return { left: r.x, top: r.y, width: r.w, height: r.h,
                   right: r.x + r.w, bottom: r.y + r.h };
        }
      };
    }
  };

  // Computed style with inheritance for the properties that matter.
  function getStyle(node) {
    const own = node.style || {};
    return {
      display:    own.display    || "block",
      visibility: own.visibility || "visible",
      opacity:    own.opacity    !== undefined ? own.opacity : "1",
      position:   own.position   || "static",
      left:       own.left       !== undefined ? own.left : "auto",
      top:        own.top        !== undefined ? own.top  : "auto",
      clip:       own.clip       || "auto",
      clipPath:   own.clipPath   || "none",
      textIndent: own.textIndent !== undefined ? own.textIndent : "0px",
      fontSize:   own.fontSize   !== undefined ? own.fontSize : "14px",
      overflow:   own.overflow   || "visible",
      overflowX:  own.overflowX  || own.overflow || "visible",
      overflowY:  own.overflowY  || own.overflow || "visible",
      color:      own.color      || "rgb(0, 0, 0)"
    };
  }

  return { doc, getStyle, SHOW_TEXT };
}

module.exports = { FakeElement, FakeText, el, clipBox, txt, hiddenTxt, makeEnv, SHOW_TEXT };
