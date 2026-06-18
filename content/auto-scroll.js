"use strict";

/*
 * Tarara auto-scroll.
 *
 * Injected by the background page into a watched tab whose row has "scroll to
 * end" enabled, on every load. It drives its own in-page loop using plain
 * instant scrollTop steps. In a hidden (background) tab Firefox throttles page
 * timers and lazy-load callbacks, so hidden tabs use longer bottom-settle
 * windows and explicit scroll events to give the page more chances to fetch the
 * next batch.
 *
 * It scrolls whichever element has the largest scrollable area — the document
 * scroller, or the tallest inner overflow:auto/scroll container (SPAs and
 * sportsbook event lists keep the document fixed and scroll an inner panel).
 * It only scrolls down and stops once the bottom settles (no more lazy content
 * arriving).
 *
 * Cardinal rule: never throw into the page.
 */

(function tararaAutoScroll() {
  if (window.__tararaAutoScrolling) return;
  window.__tararaAutoScrolling = true;

  const STEP_INTERVAL_MS = 2000; // self-paced; a hidden tab throttles this, worsening timing only
  const STEP_FRACTION_MIN = 0.225; // smallest step as a fraction of scroller height
  const STEP_FRACTION_MAX = 0.325; // largest step as a fraction of scroller height
  const SETTLE_MS = 1500; // wait at the bottom for lazy content to load
  const HIDDEN_SETTLE_MS = 3000; // hidden tabs need wider windows for throttled lazy-load work
  const MAX_IDLE_ROUNDS = 12; // stop after this many visible bottoms with no new growth
  const MAX_HIDDEN_IDLE_ROUNDS = 36; // hidden tabs can need much longer to produce the next batch
  const MAX_WAIT_ROUNDS = 20; // rounds to wait for a scroller to appear at all
  const MAX_STEPS = 2000; // hard cap so an endless feed can't scroll forever
  const MAX_BOTTOM_NUDGES = 6; // repeat bottom scroll events before declaring the feed settled

  let steps = 0;
  let idleRounds = 0;
  let waitRounds = 0;
  let bottomNudges = 0;
  let lastBottomHeight = 0;
  const debugState = {
    startedAt: new Date().toISOString(),
    updatedAt: null,
    reason: "starting",
    steps: 0,
    idleRounds: 0,
    waitRounds: 0,
    bottomNudges: 0,
    hidden: document.hidden,
    scroller: null,
    scrollTop: 0,
    clientHeight: 0,
    scrollHeight: 0,
  };
  window.__tararaAutoScrollState = debugState;

  function rand(min, max) {
    return min + Math.random() * (max - min);
  }

  function delta(el) {
    return el ? el.scrollHeight - el.clientHeight : 0;
  }

  function isScrollable(el) {
    if (delta(el) <= 4) return false;
    const oy = getComputedStyle(el).overflowY;
    return oy === "auto" || oy === "scroll" || oy === "overlay";
  }

  // The element holding the page's scrollable content: the document scroller, or
  // the inner container with the largest scrollable area when the document does
  // not itself scroll. Returns null when nothing is scrollable (yet).
  function pickScroller() {
    const doc = document.scrollingElement || document.documentElement;
    let best = doc;
    let bestDelta = delta(doc);
    const root = document.documentElement;
    const all = root ? root.getElementsByTagName("*") : [];
    for (let i = 0, n = all.length; i < n; i++) {
      const el = all[i];
      if (delta(el) <= bestDelta) continue; // cheap reject before getComputedStyle
      if (!isScrollable(el)) continue;
      bestDelta = delta(el);
      best = el;
    }
    return bestDelta > 4 ? best : null;
  }

  function atBottom(el) {
    return el.scrollTop + el.clientHeight >= el.scrollHeight - 2;
  }

  function scrollerName(el) {
    if (!el) return null;
    if (el === document.scrollingElement || el === document.documentElement || el === document.body) {
      return "document";
    }
    return [el.tagName, el.id ? `#${el.id}` : "", el.className ? `.${String(el.className).trim().split(/\s+/).join(".")}` : ""]
      .join("")
      .slice(0, 160);
  }

  function mark(reason, el) {
    debugState.updatedAt = new Date().toISOString();
    debugState.reason = reason;
    debugState.steps = steps;
    debugState.idleRounds = idleRounds;
    debugState.waitRounds = waitRounds;
    debugState.bottomNudges = bottomNudges;
    debugState.hidden = document.hidden;
    debugState.scroller = scrollerName(el);
    debugState.scrollTop = el ? Math.round(el.scrollTop) : 0;
    debugState.clientHeight = el ? Math.round(el.clientHeight) : 0;
    debugState.scrollHeight = el ? Math.round(el.scrollHeight) : 0;
  }

  function finish(reason, el) {
    mark(reason, el);
    window.__tararaAutoScrolling = false;
  }

  function settleDelay() {
    return document.hidden ? HIDDEN_SETTLE_MS : SETTLE_MS;
  }

  function maxIdleRounds() {
    return document.hidden ? MAX_HIDDEN_IDLE_ROUNDS : MAX_IDLE_ROUNDS;
  }

  function emitScrollEvents(el) {
    try {
      el.dispatchEvent(new Event("scroll", { bubbles: true }));
      window.dispatchEvent(new Event("scroll"));
    } catch (_e) {
      /* best effort only */
    }
  }

  function nudgeBottom(el) {
    const maxTop = Math.max(0, el.scrollHeight - el.clientHeight);
    if (el.scrollTop < maxTop) el.scrollTop = maxTop;
    emitScrollEvents(el);
  }

  function step() {
    try {
      if (steps++ > MAX_STEPS) {
        finish("max-steps", null);
        return;
      }

      const el = pickScroller();
      if (!el) {
        // Content (or its scroll container) may still be mounting — wait a while.
        mark("waiting-for-scroller", null);
        if (waitRounds++ < MAX_WAIT_ROUNDS) {
          setTimeout(step, settleDelay());
        } else {
          finish("no-scroller", null);
        }
        return;
      }
      waitRounds = 0;

      if (atBottom(el)) {
        if (el.scrollHeight > lastBottomHeight) {
          // Grew since we last hit the bottom: lazy content arrived, keep going.
          lastBottomHeight = el.scrollHeight;
          idleRounds = 0;
          bottomNudges = 0;
          mark("bottom-grew", el);
          setTimeout(step, settleDelay());
          return;
        }
        if (bottomNudges < MAX_BOTTOM_NUDGES) {
          bottomNudges++;
          nudgeBottom(el);
        }
        if (++idleRounds >= maxIdleRounds()) {
          finish("settled", el);
          return;
        }
        // Still waiting for lazy content; stay at the bottom and re-check.
        mark("waiting-at-bottom", el);
        setTimeout(step, settleDelay());
        return;
      }

      idleRounds = 0;
      bottomNudges = 0;
      const by = Math.max(100, Math.floor(el.clientHeight * rand(STEP_FRACTION_MIN, STEP_FRACTION_MAX)));
      el.scrollTop += by;
      emitScrollEvents(el);
      mark("scroll-step", el);
      setTimeout(step, STEP_INTERVAL_MS);
    } catch (_e) {
      finish("error", null);
      /* never throw into the page */
    }
  }

  mark("scheduled", null);
  setTimeout(step, STEP_INTERVAL_MS);
})();
