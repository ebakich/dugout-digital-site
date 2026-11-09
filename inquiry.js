/* Dugout Digital ... "Book a pilot" tap-through inquiry.
   Vanilla JS, no dependencies. Opens from any [data-inquiry] link and from #pilot in the URL.
   Posts JSON to {INQUIRY_API}/v1/dd/inquiry. The visitor never receives email from us;
   the confirmation screen carries the reference number.
   Test hook, ONLY on file: and localhost: ?flowtest=1&step=<name> renders one step with sample answers and a
   mocked network (steps: org products players timeline contact contacterr notes review sending failed done parent;
   &net=400|429|noref|fail picks the mocked reply), ?flowtest=1&walk=ok|fail drives the real buttons end to end and
   writes the result to <html data-ddf-walk="...">. Test mode never calls the real API and never touches the real draft. */
(function () {
  'use strict';

  var INQUIRY_API = "https://forms.dugoutdigital.io";

  var BRAND = 'dd';
  var HASH = '#pilot';
  var STORE_KEY = 'ddf_pilot_draft_v1';
  var DRAFT_MAX_AGE = 30 * 24 * 60 * 60 * 1000;
  var ATTEMPT_TIMEOUT = 15000;
  var RETRY_WAIT = [1500, 3500];

  var qs = {};
  try { new URLSearchParams(location.search).forEach(function (v, k) { qs[k] = v; }); } catch (e) {}
  var LOCAL = location.protocol === 'file:' || /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  var TEST = LOCAL && qs.flowtest === '1';   // never on the live site
  if (TEST) { STORE_KEY += '_test'; RETRY_WAIT = [60, 60]; }

  var ORG = [
    { v: 'tournament', t: 'Tournament', s: 'Tournaments and invitationals' },
    { v: 'showcase', t: 'Showcase', s: 'Showcases and prospect events' },
    { v: 'college_camp', t: 'College camp', s: 'Camps run by a college staff' },
    { v: 'travel_org', t: 'Travel organization', s: 'Travel teams and clubs' },
    { v: 'facility', t: 'Facility', s: 'Training facilities and academies' },
    { v: 'parent', t: "I'm a parent or player", s: 'My player goes to events' }
  ];
  var PRODUCTS = [
    { v: 'eval_card', t: 'Eval card', s: 'Every number graded, then explained' },
    { v: 'five_tool_email', t: '5 Tool Email', s: 'The recruiting email, built from his numbers' },
    { v: 'player_app', t: 'Player app', s: 'The Damage & Chaos app' },
    { v: 'player_portal', t: 'Player Portal', s: 'Verified numbers college coaches can search' },
    { v: 'all', t: 'All of it', s: 'The full package in your brand' }
  ];
  var PLAYERS = [
    { v: 'under_50', t: 'Under 50' },
    { v: '50_150', t: '50 to 150' },
    { v: '150_400', t: '150 to 400' },
    { v: '400_plus', t: '400+' }
  ];
  var TIMELINE = [
    { v: 'asap', t: 'As soon as possible' },
    { v: '1_3_months', t: '1 to 3 months' },
    { v: 'this_season', t: 'This season' },
    { v: 'exploring', t: 'Just exploring' }
  ];
  var STEPS = ['org', 'products', 'players', 'timeline', 'contact', 'notes', 'review'];
  var TOTAL = STEPS.length;
  var NOTES_MAX = 1000;

  var S = blank();
  var root, dialog, bodyEl, footEl, countEl, backBtn, bar, live, hpInput;
  var opener = null, isOpen = false, advanceLock = false, saveTimer = 0;
  var pushed = false;   // our history entry is on the stack (the phone's back gesture steps back inside the flow)

  function blank() {
    return {
      step: 'org',
      a: { org_type: '', products: [], players: '', timeline: '', notes: '' },
      c: { name: '', company: '', email: '', phone: '' },
      started_at: 0,
      pending: false,
      editing: false,
      send: { status: 'idle', msg: '' },
      fieldErr: {},
      stepErr: '',
      done: null,
      doneSeen: false
    };
  }

  /* ---------- helpers ---------- */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function find(list, v) { for (var i = 0; i < list.length; i++) if (list[i].v === v) return list[i]; return null; }
  function label(list, v) { var o = find(list, v); return o ? o.t : ''; }
  function reduced() {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; }
  }
  function trim(s, n) { s = String(s == null ? '' : s).trim(); return n ? s.slice(0, n) : s; }
  function validEmail(s) { return s.length <= 254 && /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(s); }
  function phoneOk(s) { if (!s) return true; var d = s.replace(/\D/g, ''); return d.length >= 7 && d.length <= 20 && /^[0-9+().\s-]+$/.test(s); }
  function firstName(n) { return trim(n).split(/\s+/)[0] || ''; }
  function productsText(arr) {
    if (!arr || !arr.length) return '';
    if (arr.indexOf('all') >= 0) return 'All of it';
    return arr.map(function (v) { return label(PRODUCTS, v); }).filter(Boolean).join(', ');
  }
  function uaHint() {
    var touch = false;
    try { touch = window.matchMedia('(pointer: coarse)').matches; } catch (e) {}
    return (touch ? 'touch ' : 'mouse ') + Math.round(window.innerWidth || 0) + 'w';
  }
  function announce(msg) {
    if (!live) return;
    live.textContent = '';
    setTimeout(function () { live.textContent = msg; }, 40);
  }

  /* ---------- draft (per device convenience; every access guarded) ---------- */
  function save() {
    if (S.done) return;
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        v: 1, t: Date.now(), step: STEPS.indexOf(S.step) >= 0 ? S.step : 'org',
        a: S.a, c: S.c, started_at: S.started_at, pending: S.pending
      }));
    } catch (e) {}
  }
  function saveSoon() { clearTimeout(saveTimer); saveTimer = setTimeout(save, 250); }
  function clearDraft() { try { localStorage.removeItem(STORE_KEY); } catch (e) {} }
  function load() {
    var d = null;
    try { d = JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch (e) { d = null; }
    if (!d || d.v !== 1 || typeof d.t !== 'number' || Date.now() - d.t > DRAFT_MAX_AGE) { if (d) clearDraft(); return; }
    var a = d.a || {}, c = d.c || {};
    if (typeof a.org_type === 'string' && (find(ORG, a.org_type))) S.a.org_type = a.org_type;
    if (Array.isArray(a.products)) S.a.products = a.products.filter(function (v) { return !!find(PRODUCTS, v); });
    if (find(PLAYERS, a.players)) S.a.players = a.players;
    if (find(TIMELINE, a.timeline)) S.a.timeline = a.timeline;
    if (typeof a.notes === 'string') S.a.notes = a.notes.slice(0, NOTES_MAX);
    ['name', 'company', 'email', 'phone'].forEach(function (k) { if (typeof c[k] === 'string') S.c[k] = c[k].slice(0, 254); });
    if (typeof d.started_at === 'number') S.started_at = d.started_at;
    S.pending = !!d.pending;
    if (STEPS.indexOf(d.step) >= 0) S.step = d.step;
    if (S.pending) S.step = 'review';
    if (S.a.org_type === 'parent' && S.step !== 'org') S.step = 'org';
  }

  /* ---------- markup ---------- */
  var ICON_BACK = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  var ICON_X = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>';
  var ICON_GO = '<svg class="ddf-go" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M9 5l7 7-7 7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  var ICON_CHECK = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  function head(eyebrow, title, sub) {
    return '<p class="ddf-eyebrow">' + esc(eyebrow) + '</p>' +
      '<h2 class="ddf-h" id="ddf-title" tabindex="-1">' + esc(title) + '</h2>' +
      (sub ? '<p class="ddf-sub">' + esc(sub) + '</p>' : '');
  }
  function stepErr() {
    return '<p class="ddf-err ddf-steperr" id="ddf-steperr"' + (S.stepErr ? '' : ' hidden') + '>' + esc(S.stepErr) + '</p>';
  }
  function oneOpts(key, list) {
    return '<div class="ddf-opts" role="group" aria-labelledby="ddf-title">' + list.map(function (o) {
      var on = S.a[key] === o.v;
      return '<button type="button" class="ddf-opt" data-act="pick" data-key="' + key + '" data-val="' + o.v + '" aria-pressed="' + on + '">' +
        '<span class="ddf-opt-t">' + esc(o.t) + (o.s ? '<small>' + esc(o.s) + '</small>' : '') + '</span>' + ICON_GO + '</button>';
    }).join('') + '</div>';
  }
  function manyOpts() {
    return '<div class="ddf-opts ddf-chips" role="group" aria-labelledby="ddf-title" aria-describedby="ddf-steperr">' + PRODUCTS.map(function (o) {
      var on = S.a.products.indexOf(o.v) >= 0;
      return '<button type="button" class="ddf-opt ddf-chip" data-act="toggle" data-val="' + o.v + '" aria-pressed="' + on + '">' +
        '<span class="ddf-box">' + ICON_CHECK + '</span>' +
        '<span class="ddf-opt-t">' + esc(o.t) + '<small>' + esc(o.s) + '</small></span></button>';
    }).join('') + '</div>';
  }
  function field(k, lab, type, attrs, optional) {
    var err = S.fieldErr[k] || '';
    var id = 'ddf-f-' + k;
    return '<div class="ddf-field">' +
      '<label for="' + id + '">' + esc(lab) + (optional ? ' <span class="ddf-opt-tag">optional</span>' : '') + '</label>' +
      '<input id="' + id + '" name="' + k + '" type="' + type + '" ' + attrs +
      ' value="' + esc(S.c[k]) + '"' + (err ? ' aria-invalid="true"' : '') + ' aria-describedby="' + id + '-err">' +
      '<p class="ddf-err" id="' + id + '-err"' + (err ? '' : ' hidden') + '>' + esc(err) + '</p></div>';
  }
  function summaryRows(withEdit, compact) {
    var rows = [
      ['org', 'You are', label(ORG, S.a.org_type)],
      ['products', 'You want', productsText(S.a.products)],
      ['players', 'Players per event', label(PLAYERS, S.a.players)],
      ['timeline', 'Timeline', label(TIMELINE, S.a.timeline)],
      ['contact', 'Name', S.c.name],
      ['contact', 'Organization', S.c.company || (compact ? '' : 'Not given')],
      ['contact', 'Email', S.c.email],
      ['contact', 'Phone', S.c.phone || (compact ? '' : 'Not given')],
      ['notes', 'Notes', S.a.notes || (compact ? '' : 'None')]
    ];
    return '<dl class="ddf-sum">' + rows.filter(function (r) { return r[2]; }).map(function (r) {
      return '<div class="ddf-sum-row"><dt>' + esc(r[1]) + '</dt><dd>' + esc(r[2]) + '</dd>' +
        (withEdit ? '<button type="button" class="ddf-edit" data-act="edit" data-step="' + r[0] + '" aria-label="Edit ' + esc(r[1]) + '">Edit</button>' : '') +
        '</div>';
    }).join('') + '</dl>';
  }
  function primary(act, text, extra) {
    return '<button type="button" class="ddf-primary" data-act="' + act + '"' + (extra || '') + '>' + text + '</button>';
  }

  var VIEWS = {
    org: function () {
      return head('Book a pilot', 'Which one are you?', 'Pick the one that fits best.') + oneOpts('org_type', ORG) + stepErr();
    },
    products: function () {
      return head('Book a pilot', 'What do you want to give your players?', 'Pick as many as you like.') + manyOpts() + stepErr();
    },
    players: function () {
      return head('Book a pilot', 'How many players per event?', 'A rough number is fine.') + oneOpts('players', PLAYERS) + stepErr();
    },
    timeline: function () {
      return head('Book a pilot', 'When do you want to start?') + oneOpts('timeline', TIMELINE) + stepErr();
    },
    contact: function () {
      return head('Book a pilot', 'Where should we reply?', 'We reply by email. Phone is optional.') +
        '<form class="ddf-form" id="ddf-contact" novalidate>' +
        field('name', 'Your name', 'text', 'autocomplete="name" autocapitalize="words" maxlength="120" enterkeyhint="next"') +
        field('company', 'Organization', 'text', 'autocomplete="organization" autocapitalize="words" maxlength="160" enterkeyhint="next"', true) +
        field('email', 'Email', 'email', 'autocomplete="email" inputmode="email" autocapitalize="off" spellcheck="false" maxlength="254" enterkeyhint="next"') +
        field('phone', 'Phone', 'tel', 'autocomplete="tel" inputmode="tel" maxlength="32" enterkeyhint="done"', true) +
        '<button type="submit" class="ddf-hidden-submit" tabindex="-1" aria-hidden="true">Next</button>' +
        '</form>';
    },
    notes: function () {
      var n = S.a.notes.length;
      return head('Book a pilot', 'Anything we should know?', 'Your event dates, the instruments you use, how players register.') +
        '<div class="ddf-field"><label for="ddf-notes">Notes <span class="ddf-opt-tag">optional</span></label>' +
        '<textarea id="ddf-notes" maxlength="' + NOTES_MAX + '" rows="6" aria-describedby="ddf-notes-count">' + esc(S.a.notes) + '</textarea>' +
        '<p class="ddf-count-n" id="ddf-notes-count">' + n + ' of ' + NOTES_MAX + '</p></div>' + stepErr();
    },
    review: function () {
      var st = S.send.status, box = '';
      if (S.pending && st === 'idle') {
        box = '<div class="ddf-note">Your answers were saved on this device. Tap Send request when you are ready.</div>';
      }
      if (st === 'sending' || st === 'retrying') {
        box = '<div class="ddf-note ddf-note-busy" role="status"><span class="ddf-spin" aria-hidden="true"></span>' +
          (st === 'retrying' ? 'Still trying. Your answers are saved on this device.' : 'Sending your request.') + '</div>';
      }
      if (st === 'failed' || st === 'error' || st === 'rate' || st === 'blocked') {
        box = '<div class="ddf-alert" role="alert">' + esc(S.send.msg) + '</div>';
      }
      return head('Book a pilot', 'Look it over', 'Tap Edit to change anything.') + box + summaryRows(st !== 'sending' && st !== 'retrying', false) +
        '<p class="ddf-fine">We use what you send only to reply to you. We reply by email within one business day.</p>';
    },
    done: function () {
      var fn = firstName(S.c.name);
      return '<p class="ddf-eyebrow">Request received</p>' +
        '<h2 class="ddf-h" id="ddf-title" tabindex="-1">' + esc(fn ? 'Thank you, ' + fn + '.' : 'Thank you.') + '</h2>' +
        (S.done.ref ? '<div class="ddf-ref"><span>Your reference number</span><b>' + esc(S.done.ref) + '</b></div>' : '') +
        '<p class="ddf-reply">We\'ll reply by email within one business day.</p>' +
        summaryRows(false, true);
    },
    parent: function () {
      return head('For players and families', 'Ask your event to bring Dugout Digital') +
        '<p class="ddf-p">We build eval cards for the events your player already goes to, so we do not sell to families.</p>' +
        '<p class="ddf-p">Ask your tournament, camp, travel organization or facility if they offer Dugout Digital eval cards. If they do not yet, share this page with the people who run it.</p>' +
        '<p class="ddf-p ddf-muted">Nothing was sent.</p>' +
        '<p class="ddf-share-msg" id="ddf-share-msg" role="status"></p>';
    }
  };

  /* A single-choice step advances on the tap; once answered (coming Back) it also shows Next. */
  function answered(key) { return function () { return S.a[key] ? primary('next', 'Next') : ''; }; }
  var FOOTS = {
    org: answered('org_type'),
    players: answered('players'),
    timeline: answered('timeline'),
    products: function () { return primary('next', 'Next'); },
    contact: function () { return primary('next', 'Next'); },
    notes: function () { return primary('next', S.a.notes.trim() ? 'Next' : 'Skip'); },
    review: function () {
      var st = S.send.status;
      if (st === 'sending' || st === 'retrying') {
        return '<button type="button" class="ddf-primary" disabled aria-disabled="true"><span class="ddf-spin" aria-hidden="true"></span>Sending</button>';
      }
      if (st === 'failed' || st === 'rate' || st === 'blocked') return primary('send', 'Tap to try again');
      return primary('send', 'Send request');
    },
    done: function () { return primary('close', 'Done'); },
    parent: function () {
      return primary('share', 'Share this page') +
        '<button type="button" class="ddf-secondary" data-act="close">Close</button>';
    }
  };

  /* ---------- build + render ---------- */
  function build() {
    if (root) return;
    root = document.createElement('div');
    root.className = 'ddf-root';
    root.hidden = true;
    root.innerHTML =
      '<div class="ddf-scrim" data-act="close"></div>' +
      '<div class="ddf-dialog" role="dialog" aria-modal="true" aria-labelledby="ddf-title">' +
        '<div class="ddf-top">' +
          '<button type="button" class="ddf-icon ddf-back" data-act="back">' + ICON_BACK + '<span>Back</span></button>' +
          '<p class="ddf-stepno" id="ddf-stepno"></p>' +
          '<button type="button" class="ddf-icon ddf-close" data-act="close" aria-label="Close">' + ICON_X + '</button>' +
        '</div>' +
        '<div class="ddf-progress" role="progressbar" aria-label="Progress" aria-valuemin="0" aria-valuemax="' + TOTAL + '" aria-valuenow="1"><i></i></div>' +
        '<div class="ddf-body" id="ddf-body"></div>' +
        '<div class="ddf-foot" id="ddf-foot"></div>' +
        '<p class="ddf-sr" aria-live="polite" id="ddf-live"></p>' +
        '<div class="ddf-hp" aria-hidden="true"><label>Leave this field empty <input type="text" name="hp" tabindex="-1" autocomplete="off"></label></div>' +
      '</div>';
    document.body.appendChild(root);
    dialog = root.querySelector('.ddf-dialog');
    bodyEl = root.querySelector('#ddf-body');
    footEl = root.querySelector('#ddf-foot');
    countEl = root.querySelector('#ddf-stepno');
    backBtn = root.querySelector('.ddf-back');
    bar = root.querySelector('.ddf-progress');
    live = root.querySelector('#ddf-live');
    hpInput = root.querySelector('.ddf-hp input');

    root.addEventListener('click', onClick);
    root.addEventListener('input', onInput);
    root.addEventListener('submit', function (e) { e.preventDefault(); next(); });
    root.addEventListener('keydown', onKey);
  }

  function render(focus) {
    var st = S.step, idx = STEPS.indexOf(st);
    var busy = S.send.status === 'sending' || S.send.status === 'retrying';
    var n = st === 'done' ? TOTAL : (idx >= 0 ? idx + 1 : 1);
    countEl.textContent = st === 'done' ? 'Sent' : st === 'parent' ? 'For families' : 'Step ' + (idx + 1) + ' of ' + TOTAL;
    bar.setAttribute('aria-valuenow', String(n));
    bar.setAttribute('aria-valuetext', countEl.textContent);
    bar.firstChild.style.width = (st === 'parent' ? 100 : Math.round(n / TOTAL * 100)) + '%';
    bar.classList.toggle('ddf-progress-alt', st === 'parent');
    backBtn.style.visibility = (st === 'org' || st === 'done' || busy) ? 'hidden' : 'visible';
    bodyEl.innerHTML = '<div class="ddf-step">' + VIEWS[st]() + '</div>';
    var f = FOOTS[st] ? FOOTS[st]() : '';
    footEl.innerHTML = f;
    footEl.hidden = !f;
    bodyEl.scrollTop = 0;
    if (!reduced() && !TEST) {
      var stepEl = bodyEl.firstChild;
      stepEl.classList.add('ddf-enter');
      var entered = function () { stepEl.classList.remove('ddf-enter'); };
      requestAnimationFrame(function () { requestAnimationFrame(entered); });
      setTimeout(entered, 60);
    }
    if (focus !== false) {
      var target = (focus && typeof focus === 'string') ? root.querySelector(focus) : null;
      (target || root.querySelector('#ddf-title')).focus({ preventScroll: true });
    }
  }

  function go(step, focus) {
    S.step = step;
    S.stepErr = '';
    if (step !== 'contact') S.fieldErr = {};
    save();
    render(focus);
  }

  /* ---------- navigation ---------- */
  function nextStepAfter(step) {
    if (S.editing && step !== 'review') return 'review';
    var i = STEPS.indexOf(step);
    return STEPS[Math.min(i + 1, STEPS.length - 1)];
  }

  function pick(key, val) {
    if (advanceLock) return;
    S.a[key] = val;
    save();
    root.querySelectorAll('.ddf-opt[data-key="' + key + '"]').forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.getAttribute('data-val') === val));
    });
    advanceLock = true;
    setTimeout(function () {
      advanceLock = false;
      if (!isOpen) return;
      if (key === 'org_type' && val === 'parent') { S.editing = false; go('parent'); return; }
      go(nextStepAfter(S.step));
    }, 170);
  }

  function toggle(val) {
    var p = S.a.products.slice();
    var i = p.indexOf(val);
    if (val === 'all') {
      p = i >= 0 ? [] : ['all'];
    } else {
      p = p.filter(function (v) { return v !== 'all'; });   // ticking all four keeps all four ticked
      if (i >= 0) p.splice(p.indexOf(val), 1); else p.push(val);
    }
    S.a.products = p;
    S.stepErr = '';
    save();
    root.querySelectorAll('.ddf-chip').forEach(function (b) {
      b.setAttribute('aria-pressed', String(p.indexOf(b.getAttribute('data-val')) >= 0));
    });
    var e = root.querySelector('#ddf-steperr');
    if (e) { e.hidden = true; e.textContent = ''; }
  }

  function validateContact() {
    var c = S.c, err = {};
    c.name = trim(c.name, 120); c.company = trim(c.company, 160); c.email = trim(c.email, 254); c.phone = trim(c.phone, 32);
    if (!c.name) err.name = 'Add your name so we know who to reply to.';
    if (!c.email) err.email = 'Add your email. That is where we reply.';
    else if (!validEmail(c.email)) err.email = 'That email does not look right. Check it and try again.';
    if (!phoneOk(c.phone)) err.phone = 'Check that phone number, or leave it blank.';
    S.fieldErr = err;
    return err;
  }

  function next() {
    var st = S.step;
    if (st === 'org' && S.a.org_type === 'parent') { S.editing = false; go('parent'); return; }
    if ((st === 'org' && !S.a.org_type) || (st === 'players' && !S.a.players) || (st === 'timeline' && !S.a.timeline)) return;
    if (st === 'products') {
      if (!S.a.products.length) {
        S.stepErr = 'Pick at least one.';
        var e = root.querySelector('#ddf-steperr');
        e.textContent = S.stepErr; e.hidden = false;
        announce(S.stepErr);
        return;
      }
    }
    if (st === 'contact') {
      var err = validateContact();
      var keys = ['name', 'email', 'phone'].filter(function (k) { return err[k]; });
      save();
      ['name', 'company', 'email', 'phone'].forEach(function (k) {
        var inp = root.querySelector('#ddf-f-' + k), msg = root.querySelector('#ddf-f-' + k + '-err');
        if (!inp || !msg) return;
        if (inp.value !== S.c[k]) inp.value = S.c[k];
        if (err[k]) { inp.setAttribute('aria-invalid', 'true'); msg.textContent = err[k]; msg.hidden = false; }
        else { inp.removeAttribute('aria-invalid'); msg.textContent = ''; msg.hidden = true; }
      });
      if (keys.length) {
        var bad = root.querySelector('#ddf-f-' + keys[0]);
        if (bad) bad.focus();
        announce(err[keys[0]]);
        return;
      }
    }
    if (st === 'notes') S.a.notes = S.a.notes.slice(0, NOTES_MAX);
    go(nextStepAfter(st));
  }

  function back() {
    var st = S.step;
    if (S.send.status === 'sending' || S.send.status === 'retrying') return;
    if (st === 'parent') { go('org'); return; }
    if (S.editing && st !== 'review') { go('review'); return; }
    var i = STEPS.indexOf(st);
    if (i > 0) { S.editing = false; go(STEPS[i - 1]); }
  }

  function share() {
    var url = location.href.split('#')[0].split('?')[0];
    var msg = root.querySelector('#ddf-share-msg');
    function said(t) { if (msg) msg.textContent = t; }
    if (navigator.share) {
      navigator.share({ title: 'Dugout Digital', text: 'Eval cards, recruiting emails and a player app, in your event\'s brand.', url: url })
        .catch(function () {});
      return;
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(function () { said('Link copied. Send it to your event.'); },
        function () { said('Copy this link: ' + url); });
    } else {
      said('Copy this link: ' + url);
    }
  }

  /* ---------- send ---------- */
  function payload() {
    var a = { org_type: S.a.org_type, products: S.a.products.slice(), players: S.a.players, timeline: S.a.timeline };
    if (S.c.company) a.org_name = S.c.company;
    if (S.a.notes.trim()) a.notes = S.a.notes.trim().slice(0, NOTES_MAX);
    var c = { name: S.c.name, email: S.c.email };
    if (S.c.phone) c.phone = S.c.phone;
    if (S.c.company) c.company = S.c.company;
    return {
      answers: a,
      contact: c,
      meta: { started_at: S.started_at || Date.now(), page: location.pathname, ua_hint: uaHint() },
      hp: hpInput ? hpInput.value : ''
    };
  }

  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /* A 400 names one field ("email: ..."). Never show that text: go to the step that holds the field and
     say what to fix in plain words. -> true when handled. */
  var FIELD_FIX = {
    org_type: ['org', '', 'Pick the one that fits best.'],
    products: ['products', '', 'Pick at least one.'],
    players: ['players', '', 'Pick a rough number of players.'],
    timeline: ['timeline', '', 'Pick when you want to start.'],
    contact: ['contact', 'name', 'Check your name and email.'],
    name: ['contact', 'name', 'Add your name so we know who to reply to.'],
    email: ['contact', 'email', 'Check the email address.'],
    phone: ['contact', 'phone', 'Check that phone number, or leave it blank.'],
    company: ['contact', 'company', 'Shorten the organization name.'],
    org_name: ['contact', 'company', 'Shorten the organization name.'],
    notes: ['notes', '', 'Shorten your notes.']
  };
  function fieldFix(error) {
    var fix = FIELD_FIX[String(error || '').split(':')[0].trim()];
    if (!fix) return false;
    S.send = { status: 'idle', msg: '' };
    S.editing = true;
    if (fix[1]) {
      S.fieldErr = {};
      S.fieldErr[fix[1]] = fix[2];
      go(fix[0], '#ddf-f-' + fix[1]);
    } else {
      go(fix[0]);
      S.stepErr = fix[2];
      var e = root.querySelector('#ddf-steperr');
      if (e) { e.textContent = fix[2]; e.hidden = false; }
    }
    announce(fix[2]);
    return true;
  }

  function realPost(body) {
    var ctrl = ('AbortController' in window) ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, ATTEMPT_TIMEOUT) : 0;
    return fetch(INQUIRY_API.replace(/\/+$/, '') + '/v1/' + BRAND + '/inquiry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'omit',
      cache: 'no-store',
      signal: ctrl ? ctrl.signal : undefined
    }).then(function (res) {
      clearTimeout(timer);
      return res.json().catch(function () { return null; }).then(function (j) { return { status: res.status, json: j }; });
    }, function (e) { clearTimeout(timer); throw e; });
  }

  function mockPost() {
    var net = qs.net || (qs.walk === 'fail' ? 'fail' : 'ok');
    window.__ddfLastPayload = arguments[0];
    return wait(120).then(function () {
      if (net === 'fail') throw new TypeError('Failed to fetch');
      if (net === '400') return { status: 400, json: { ok: false, error: 'email: enter a valid email address' } };
      if (net === '429') return { status: 429, json: { ok: false, error: 'rate' } };
      if (net === 'noref') return { status: 200, json: { ok: true } };
      return { status: 200, json: { ok: true, ref: 'DD-2611-7Q3K' } };
    });
  }

  function send() {
    var st = S.send.status;
    if (st === 'sending' || st === 'retrying') return;
    var miss = !find(ORG, S.a.org_type) || S.a.org_type === 'parent' ? 'org' : !S.a.products.length ? 'products'
      : !S.a.players ? 'players' : !S.a.timeline ? 'timeline' : null;
    if (!miss) { var ce = validateContact(); if (ce.name || ce.email || ce.phone) miss = 'contact'; }
    if (miss) { S.editing = true; go(miss); announce('One answer is missing.'); return; }

    if (!S.started_at) S.started_at = Date.now();
    S.pending = true;
    save();
    var body = payload();
    var post = TEST ? mockPost : realPost;
    var attempt = 0;
    S.send = { status: 'sending', msg: '' };
    render(false);
    announce('Sending your request.');

    function fail(status, msg) {
      S.send = { status: status, msg: msg };
      save();
      if (!isOpen) return;
      render(false);
      var tb = footEl.querySelector('.ddf-primary') || root.querySelector('#ddf-title');
      tb.focus({ preventScroll: true });
    }

    function tryOnce() {
      return post(body).then(function (r) {
        var j = r.json || {};
        if (r.status >= 200 && r.status < 300 && j.ok === true) {   // stored, with or without a reference
          S.done = { ref: typeof j.ref === 'string' ? j.ref.slice(0, 40) : '' };
          S.pending = false;
          S.editing = false;
          S.send = { status: 'idle', msg: '' };
          clearDraft();
          S.step = 'done';
          if (isOpen) {
            S.doneSeen = true;
            render();
            announce(S.done.ref ? 'Sent. Your reference number is ' + S.done.ref + '.' : 'Sent.');
          }
          return;
        }
        if (r.status === 400) {
          var err = j.error ? String(j.error) : '';
          if (/^started_at/.test(err)) { fail('error', 'That was quick. Wait a moment, then tap Send request.'); return; }
          if (isOpen && fieldFix(err)) { save(); return; }
          fail('error', 'Something in the form needs a look. Tap Edit to fix it, then tap Send request.');
          return;
        }
        if (r.status === 429) {
          fail('rate', 'Too many tries from this connection. Wait a minute, then tap to try again. Your answers are saved on this device.');
          return;
        }
        if (r.status === 403) {
          fail('blocked', 'This page is not able to send right now. Your answers are saved on this device.');
          return;
        }
        throw new Error('server ' + r.status);
      }).catch(function () {
        if (S.step === 'done') return;
        if (attempt < RETRY_WAIT.length) {
          var ms = RETRY_WAIT[attempt];
          attempt += 1;
          S.send = { status: 'retrying', msg: '' };
          if (isOpen) render(false);
          return wait(ms).then(tryOnce);
        }
        fail('failed', 'We could not reach our server. Your answers are saved on this device.');
      });
    }
    tryOnce();
  }

  /* ---------- events ---------- */
  function onClick(e) {
    var t = e.target.closest('[data-act]');
    if (!t || !root.contains(t)) return;
    var act = t.getAttribute('data-act');
    if (act === 'close') { close(); return; }
    if (act === 'back') { back(); return; }
    if (act === 'pick') { pick(t.getAttribute('data-key'), t.getAttribute('data-val')); return; }
    if (act === 'toggle') { toggle(t.getAttribute('data-val')); return; }
    if (act === 'next') { next(); return; }
    if (act === 'send') { send(); return; }
    if (act === 'share') { share(); return; }
    if (act === 'edit') {
      if (S.send.status !== 'idle') S.send = { status: 'idle', msg: '' };
      S.editing = true;
      go(t.getAttribute('data-step'));
    }
  }

  function onInput(e) {
    var t = e.target;
    if (t === hpInput) return;
    if (t.id === 'ddf-notes') {
      S.a.notes = t.value.slice(0, NOTES_MAX);
      var cn = root.querySelector('#ddf-notes-count');
      if (cn) cn.textContent = S.a.notes.length + ' of ' + NOTES_MAX;
      var nb = footEl.querySelector('.ddf-primary');
      if (nb) nb.textContent = S.a.notes.trim() ? 'Next' : 'Skip';
      saveSoon();
      return;
    }
    if (t.name && Object.prototype.hasOwnProperty.call(S.c, t.name)) {
      S.c[t.name] = t.value;
      if (S.fieldErr[t.name]) {
        delete S.fieldErr[t.name];
        t.removeAttribute('aria-invalid');
        var er = root.querySelector('#' + t.id + '-err');
        if (er) { er.hidden = true; er.textContent = ''; }
      }
      saveSoon();
    }
  }

  function focusables() {
    return Array.prototype.filter.call(
      dialog.querySelectorAll('button, [href], input, textarea, select, [tabindex]:not([tabindex="-1"])'),
      function (el) {
        if (el.disabled || el.getAttribute('tabindex') === '-1' || el.closest('[hidden]') || el.closest('.ddf-hp')) return false;
        var cs = window.getComputedStyle(el);
        return cs.visibility !== 'hidden' && cs.display !== 'none';
      });
  }

  /* Enter in a contact field moves to the next field; only the last one (phone) goes on to the next step. */
  var ENTER_NEXT = { 'ddf-f-name': 'ddf-f-company', 'ddf-f-company': 'ddf-f-email', 'ddf-f-email': 'ddf-f-phone' };
  function onKey(e) {
    if (e.key === 'Enter' && !e.isComposing && e.target && ENTER_NEXT[e.target.id]) {
      var nx = root.querySelector('#' + ENTER_NEXT[e.target.id]);
      if (nx) { e.preventDefault(); nx.focus(); return; }
    }
    if (e.key === 'Escape') {
      if (S.send.status === 'sending' || S.send.status === 'retrying') return;
      e.preventDefault();
      close();
      return;
    }
    if (e.key === 'Tab') {
      var f = focusables();
      if (!f.length) return;
      var first = f[0], last = f[f.length - 1], a = document.activeElement;
      if (e.shiftKey && (a === first || !dialog.contains(a) || a.id === 'ddf-title')) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && a === last) { e.preventDefault(); first.focus(); }
    }
  }

  /* ---------- open / close ---------- */
  var inerted = [];
  function setInert(on) {
    if (on) {
      inerted = [];
      Array.prototype.forEach.call(document.body.children, function (el) {
        if (el === root || el.tagName === 'SCRIPT' || el.inert) return;
        el.inert = true;
        el.setAttribute('aria-hidden', 'true');
        inerted.push(el);
      });
    } else {
      inerted.forEach(function (el) { el.inert = false; el.removeAttribute('aria-hidden'); });
      inerted = [];
    }
  }

  /* History: opening adds one entry, so the phone's back gesture steps back inside the flow instead of
     leaving the site (the first step or the confirmation closes it). Closing from a button pops that entry. */
  function pushEntry() {
    try { history.pushState({ ddf: 1 }, ''); pushed = true; } catch (e) { pushed = false; }
  }
  function onPop() {
    if (!pushed) return;
    pushed = false;            // the browser just took our entry off the stack
    if (!isOpen) return;
    if (S.send.status === 'sending' || S.send.status === 'retrying') { pushEntry(); return; }
    if (S.step === 'org' || S.step === 'done') { close(true); return; }
    back();
    pushEntry();
  }

  function open(fromEl) {
    build();
    if (isOpen) return;
    if (S.done && S.doneSeen) S = blank();
    if (S.done) S.doneSeen = true;
    if (!S.started_at && !TEST) load();
    if (!S.started_at) S.started_at = Date.now();
    opener = fromEl || document.activeElement;
    if (location.hash === HASH) {
      try { history.replaceState(history.state, '', location.pathname + location.search); } catch (e) {}
    }
    pushEntry();
    isOpen = true;
    root.hidden = false;
    document.documentElement.classList.add('ddf-lock');
    setInert(true);
    if (!reduced() && !TEST) {
      root.classList.add('ddf-opening');
      var shown = function () { root.classList.remove('ddf-opening'); };
      requestAnimationFrame(function () { requestAnimationFrame(shown); });
      setTimeout(shown, 60);
    }
    render();
  }

  function close(fromPop) {
    if (!isOpen) return;
    isOpen = false;
    save();
    root.hidden = true;
    document.documentElement.classList.remove('ddf-lock');
    setInert(false);
    if (S.done && S.doneSeen) S = blank();
    if (fromPop !== true && pushed) { pushed = false; try { history.back(); } catch (e) {} }
    if (opener && typeof opener.focus === 'function' && document.contains(opener)) opener.focus();
    opener = null;
  }

  function wire() {
    document.addEventListener('click', function (e) {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      var a = e.target.closest('[data-inquiry]');
      if (!a) return;
      e.preventDefault();
      open(a);
    });
    window.addEventListener('hashchange', function () { if (location.hash === HASH) open(); });
    window.addEventListener('popstate', onPop);
    if (location.hash === HASH) open();
    if (TEST) runTest();
  }

  /* ---------- test hook (never calls the network) ---------- */
  function sample() {
    S.a = { org_type: 'tournament', products: ['eval_card', 'five_tool_email', 'player_app'], players: '150_400', timeline: '1_3_months',
      notes: 'Fall Classic, 14U to 17U, TrackMan on two fields, registration through our own site.' };
    S.c = { name: 'Jordan Ellis', company: 'Example Showcase Series', email: 'jordan@example.com', phone: '' };
    S.started_at = Date.now() - 95000;
  }

  function runTest() {
    var step = qs.step || 'org';
    var walk = qs.walk;
    try { localStorage.removeItem(STORE_KEY); } catch (e) {}
    if (walk) { open(); walkThrough(walk); return; }
    if (step !== 'org' && step !== 'parent') sample();
    if (step === 'parent') S.a.org_type = 'parent';
    open();
    if (step === 'contacterr') { S.c = { name: '', company: '', email: 'jordan@', phone: '' }; go('contact'); next(); return; }
    if (step === 'sending') { go('review'); S.send = { status: 'sending', msg: '' }; render(false); return; }
    if (step === 'failed') { go('review'); S.send = { status: 'failed', msg: 'We could not reach our server. Your answers are saved on this device.' }; render(false); return; }
    if (step === 'done') { S.done = { ref: 'DD-2611-7Q3K' }; S.doneSeen = true; S.step = 'done'; render(); return; }
    if (step === 'products' && qs.empty === '1') { S.a.products = []; go('products'); next(); return; }
    if (VIEWS[step]) go(step);
  }

  function walkThrough(mode) {
    var log = [];
    var html = document.documentElement;
    function q(sel) { return root.querySelector(sel); }
    function click(sel) { var el = q(sel); if (!el) throw new Error('missing ' + sel); el.click(); }
    function setVal(id, v) { var el = q(id); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }
    function title() { var h = q('#ddf-title'); return h ? h.textContent : ''; }
    function step(fn, ms) { return function () { return wait(ms || 260).then(fn); }; }
    var chain = Promise.resolve()
      .then(step(function () { log.push('1:' + title() + ':' + (document.activeElement && document.activeElement.id)); click('[data-val="showcase"]'); }))
      .then(step(function () { log.push('2:' + title()); click('[data-act="next"]'); }))
      .then(step(function () {
        log.push('2err:' + (q('#ddf-steperr').hidden ? 'none' : q('#ddf-steperr').textContent));
        click('[data-val="eval_card"]'); click('[data-val="player_portal"]'); click('[data-act="next"]');
      }))
      .then(step(function () { log.push('3:' + title()); click('[data-val="50_150"]'); }))
      .then(step(function () { log.push('4:' + title()); click('[data-val="this_season"]'); }))
      .then(step(function () {
        log.push('5:' + title());
        setVal('#ddf-f-email', 'casey@'); click('[data-act="next"]');
      }))
      .then(step(function () {
        log.push('5err:' + (q('#ddf-f-name-err').textContent) + '|' + q('#ddf-f-email-err').textContent + '|focus=' + document.activeElement.id);
        setVal('#ddf-f-name', 'Casey Moore'); setVal('#ddf-f-company', 'Scout Team Prospects');
        setVal('#ddf-f-email', 'casey@example.org'); click('[data-act="next"]');
      }))
      .then(step(function () { log.push('6:' + title() + ':' + footEl.textContent); setVal('#ddf-notes', 'Two showcases a month.'); click('[data-act="next"]'); }))
      .then(step(function () { log.push('7:' + title() + ':rows=' + root.querySelectorAll('.ddf-sum-row').length); click('[data-act="send"]'); }))
      .then(step(function () { log.push('sending:' + footEl.textContent); }, 40))
      .then(step(function () {
        var p = window.__ddfLastPayload || {};
        log.push('payload:' + JSON.stringify(p));
        if (mode === 'fail') {
          var stored = null;
          try { stored = JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch (e) {}
          log.push('end:' + (q('.ddf-alert') ? q('.ddf-alert').textContent : 'no alert') + '|button=' + footEl.textContent + '|stored=' + !!(stored && stored.pending));
          html.setAttribute('data-ddf-walk', (q('.ddf-alert') && /Tap to try again/.test(footEl.textContent) && stored && stored.pending) ? 'pass' : 'fail');
        } else {
          log.push('end:' + title() + '|' + (q('.ddf-ref') ? q('.ddf-ref').textContent : 'no ref'));
          html.setAttribute('data-ddf-walk', S.step === 'done' && q('.ddf-ref') ? 'pass' : 'fail');
        }
      }, mode === 'fail' ? 900 : 500))
      .catch(function (err) { log.push('error:' + err.message); html.setAttribute('data-ddf-walk', 'fail'); })
      .then(function () { html.setAttribute('data-ddf-log', log.join(' || ')); });
    return chain;
  }

  window.DugoutInquiry = { open: function () { open(); }, close: close };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();
})();
