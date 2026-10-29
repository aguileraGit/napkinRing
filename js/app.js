(() => {
  'use strict';

  const config = window.NAPKIN_CONFIG || {};
  const API = String(config.pocketbaseUrl || '').replace(/\/+$/, '') + '/api/collections/guestbook/records';
  const STORE_KEY = 'napkinring';
  const PER_PAGE = 200;

  const $ = (sel, root = document) => root.querySelector(sel);

  // ---------- Ring and key from the URL fragment ----------

  const isValid = (c) => !!c && /^[1-4]$/.test(c.ring) && typeof c.key === 'string' && /^\S{1,256}$/.test(c.key);

  function readCredentials() {
    let fromHash = null;
    if (location.hash.length > 1) {
      const params = new URLSearchParams(location.hash.slice(1));
      fromHash = { ring: params.get('ring'), key: params.get('key') };
      // Drop the fragment so the key does not linger in the address bar or history.
      history.replaceState(null, '', location.pathname + location.search);
    }
    try {
      if (isValid(fromHash)) {
        sessionStorage.setItem(STORE_KEY, JSON.stringify(fromHash));
        return fromHash;
      }
      const stored = JSON.parse(sessionStorage.getItem(STORE_KEY) || 'null');
      if (isValid(stored)) return stored;
    } catch (_) {
      if (isValid(fromHash)) return fromHash;
    }
    return null;
  }

  const creds = readCredentials();

  // ---------- API ----------

  class ApiError extends Error {
    constructor(kind, fields) {
      super(kind);
      this.kind = kind; // 'rate' | 'key' | 'invalid' | 'server' | 'network'
      this.fields = fields || [];
    }
  }

  async function request(url, options = {}) {
    let res;
    try {
      res = await fetch(url, {
        ...options,
        headers: { 'X-Napkin-Key': creds.key, ...(options.headers || {}) },
        referrerPolicy: 'no-referrer',
      });
    } catch (_) {
      throw new ApiError('network');
    }
    let body = null;
    try { body = await res.json(); } catch (_) { /* empty or non-JSON body */ }
    if (res.ok) return body;

    if (res.status === 429) throw new ApiError('rate');
    if (res.status === 401 || res.status === 403 || res.status === 404) throw new ApiError('key');
    if (res.status === 400) {
      // A field validation failure names the fields; a failed API rule does not.
      const fields = body && body.data && typeof body.data === 'object' ? Object.keys(body.data) : [];
      throw fields.length ? new ApiError('invalid', fields) : new ApiError('key');
    }
    throw new ApiError('server');
  }

  async function fetchAll({ filter, fields } = {}) {
    const items = [];
    for (let page = 1; page <= 100; page++) {
      const params = new URLSearchParams({ page: String(page), perPage: String(PER_PAGE), sort: '-date,-created', skipTotal: '1' });
      if (filter) params.set('filter', filter);
      if (fields) params.set('fields', fields);
      const body = await request(API + '?' + params);
      const batch = (body && Array.isArray(body.items)) ? body.items : [];
      items.push(...batch);
      if (batch.length < PER_PAGE) break;
    }
    return items;
  }

  const FIELD_LABELS = { guest_name: 'name', date: 'date', comment: 'comment', dinner_rating: 'dinner rating', ring: 'ring' };

  function messageFor(err, action) {
    switch (err && err.kind) {
      case 'rate':
        return 'Too many requests in a short time. Wait a minute, then try again.';
      case 'key':
        return 'The guest book did not accept this ring. Tap your napkin ring again to reopen the page.';
      case 'invalid':
        return 'The guest book did not accept the ' + err.fields.map((f) => FIELD_LABELS[f] || f).join(', ') + '. Check it and try again.';
      case 'server':
        return 'The guest book had a problem ' + action + '. Try again in a moment.';
      default:
        return 'Could not reach the guest book. Check your connection and try again.';
    }
  }

  // ---------- Dates ----------

  const pad = (n) => String(n).padStart(2, '0');

  function todayLocal() {
    const d = new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  const dateFormat = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

  // PocketBase dates look like "2026-10-29 12:00:00.000Z". Only the day matters here.
  function dayOf(pbDate) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(pbDate || '');
    if (!m) return null;
    return { iso: m[1] + '-' + m[2] + '-' + m[3], label: dateFormat.format(Date.UTC(+m[1], +m[2] - 1, +m[3])) };
  }

  // ---------- Views ----------

  const views = { tap: $('#state-tap'), form: $('#state-form'), thanks: $('#state-thanks') };
  function show(name) {
    for (const [key, el] of Object.entries(views)) el.hidden = key !== name;
  }

  if (!creds) {
    show('tap');
    return;
  }

  show('form');
  $('#books').hidden = false;
  $('#ring-note').textContent = 'You are signing from the Guest ' + creds.ring + ' ring.';

  // ---------- Name suggestions ----------

  const nameInput = $('#guest-name');
  const nameList = $('#name-list');
  let knownNames = [];
  let matches = [];
  let active = -1;

  function closeSuggestions() {
    nameList.hidden = true;
    nameInput.setAttribute('aria-expanded', 'false');
    nameInput.removeAttribute('aria-activedescendant');
    active = -1;
  }

  function renderSuggestions() {
    const q = nameInput.value.trim().toLowerCase();
    if (!q) { closeSuggestions(); return; }
    const starts = [];
    const contains = [];
    for (const name of knownNames) {
      const lower = name.toLowerCase();
      if (lower === q) continue;
      if (lower.startsWith(q)) starts.push(name);
      else if (lower.includes(q)) contains.push(name);
    }
    matches = starts.concat(contains).slice(0, 6);
    if (!matches.length) { closeSuggestions(); return; }
    nameList.replaceChildren(...matches.map((name, i) => {
      const li = document.createElement('li');
      li.id = 'name-option-' + i;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', 'false');
      li.textContent = name;
      return li;
    }));
    active = -1;
    nameInput.removeAttribute('aria-activedescendant');
    nameList.hidden = false;
    nameInput.setAttribute('aria-expanded', 'true');
  }

  function highlight(i) {
    active = i;
    [...nameList.children].forEach((li, j) => li.setAttribute('aria-selected', String(j === i)));
    const li = nameList.children[i];
    if (li) {
      nameInput.setAttribute('aria-activedescendant', li.id);
      li.scrollIntoView({ block: 'nearest' });
    }
  }

  function choose(i) {
    nameInput.value = matches[i];
    closeSuggestions();
    clearFieldError(nameInput);
  }

  nameInput.addEventListener('input', () => { renderSuggestions(); clearFieldError(nameInput); });
  nameInput.addEventListener('blur', closeSuggestions);
  nameInput.addEventListener('keydown', (e) => {
    const open = !nameList.hidden;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!open) renderSuggestions();
      if (!matches.length || nameList.hidden) return;
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      highlight((active + step + matches.length) % matches.length);
    } else if (e.key === 'Enter' && open && active >= 0) {
      e.preventDefault();
      choose(active);
    } else if (e.key === 'Escape' && open) {
      e.preventDefault();
      closeSuggestions();
    }
  });
  // Keep focus in the input while picking with a pointer.
  nameList.addEventListener('pointerdown', (e) => e.preventDefault());
  nameList.addEventListener('click', (e) => {
    const li = e.target.closest('[role="option"]');
    if (li) choose([...nameList.children].indexOf(li));
  });

  // Loaded once; suggestions only ever come from names already saved.
  fetchAll({ fields: 'guest_name' })
    .then((items) => {
      const seen = new Map();
      for (const { guest_name: raw } of items) {
        const name = String(raw || '').trim().replace(/\s+/g, ' ');
        if (name && !seen.has(name.toLowerCase())) seen.set(name.toLowerCase(), name);
      }
      knownNames = [...seen.values()].sort((a, b) => a.localeCompare(b));
    })
    .catch(() => { /* No suggestions; signing still works. */ });

  // ---------- The form ----------

  const form = $('#sign-form');
  const dateInput = $('#entry-date');
  const commentInput = $('#entry-comment');
  const submitBtn = $('#submit-btn');
  const formError = $('#form-error');
  const ratingClear = $('#rating-clear');
  const ratingInputs = [...form.querySelectorAll('input[name="dinner_rating"]')];

  dateInput.value = todayLocal();

  function setFieldError(input, message) {
    const err = $('#' + input.id + '-error');
    input.setAttribute('aria-invalid', 'true');
    input.setAttribute('aria-describedby', err.id);
    err.textContent = message;
    err.hidden = false;
  }

  function clearFieldError(input) {
    const err = $('#' + input.id + '-error');
    input.removeAttribute('aria-invalid');
    input.removeAttribute('aria-describedby');
    if (err) { err.hidden = true; err.textContent = ''; }
  }

  dateInput.addEventListener('input', () => clearFieldError(dateInput));

  const selectedRating = () => {
    const checked = ratingInputs.find((r) => r.checked);
    return checked ? Number(checked.value) : null;
  };

  form.addEventListener('change', (e) => {
    if (e.target.name === 'dinner_rating') ratingClear.hidden = false;
  });
  ratingClear.addEventListener('click', () => {
    const wasChecked = ratingInputs.find((r) => r.checked);
    ratingInputs.forEach((r) => { r.checked = false; });
    ratingClear.hidden = true;
    (wasChecked || ratingInputs[0]).focus();
  });

  function setBusy(busy) {
    submitBtn.disabled = busy;
    submitBtn.setAttribute('aria-busy', String(busy));
    submitBtn.textContent = busy ? 'Signing…' : 'Sign the book';
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    closeSuggestions();
    formError.hidden = true;

    const name = nameInput.value.trim().replace(/\s+/g, ' ');
    const day = dateInput.value;
    let firstInvalid = null;

    clearFieldError(nameInput);
    clearFieldError(dateInput);
    if (!name) {
      setFieldError(nameInput, 'Write your name to sign.');
      firstInvalid = nameInput;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      setFieldError(dateInput, 'Pick the date of your visit.');
      firstInvalid = firstInvalid || dateInput;
    }
    if (firstInvalid) { firstInvalid.focus(); return; }

    const payload = {
      guest_name: name,
      // Noon UTC keeps the chosen day the same in every time zone.
      date: day + ' 12:00:00.000Z',
      comment: commentInput.value.trim(),
      ring: creds.ring,
    };
    const rating = selectedRating();
    if (rating) payload.dinner_rating = rating;

    setBusy(true);
    try {
      const record = await request(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      // Only a record the server sends back counts as saved.
      if (!record || !record.id) throw new ApiError('server');
      showThanks(record);
    } catch (err) {
      formError.textContent = messageFor(err, 'saving your entry');
      formError.hidden = false;
    } finally {
      setBusy(false);
    }
  });

  function showThanks(record) {
    const day = dayOf(record.date);
    const stampDate = $('#stamp-date');
    stampDate.textContent = day ? day.label : '';
    if (day) stampDate.dateTime = day.iso; else stampDate.removeAttribute('datetime');
    show('thanks');
    $('#thanks-title').focus();
  }

  $('#sign-again').addEventListener('click', () => {
    form.reset();
    dateInput.value = todayLocal();
    ratingClear.hidden = true;
    formError.hidden = true;
    show('form');
    nameInput.focus();
  });

  // ---------- Dialogs ----------

  function setupDialog(dialog) {
    let opener = null;
    let pressedBackdrop = false;

    dialog.querySelector('[data-close]').addEventListener('click', () => dialog.close());
    // The dialog has no padding, so a click landing on the element itself is on the backdrop.
    dialog.addEventListener('pointerdown', (e) => { pressedBackdrop = e.target === dialog; });
    dialog.addEventListener('click', (e) => {
      if (e.target === dialog && pressedBackdrop) dialog.close();
      pressedBackdrop = false;
    });
    dialog.addEventListener('keydown', (e) => {
      if (e.key !== 'Tab') return;
      const focusable = [...dialog.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
        .filter((el) => !el.disabled && !el.closest('[hidden]') && !(el.type === 'radio' && !el.checked));
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });
    dialog.addEventListener('close', () => { if (opener) opener.focus(); });

    return {
      open() {
        opener = document.activeElement;
        dialog.showModal();
      },
    };
  }

  function renderSkeleton(list, state) {
    state.className = 'list-state';
    state.replaceChildren();
    list.replaceChildren(...[0, 1, 2].map(() => {
      const li = document.createElement('li');
      li.className = 'skeleton';
      li.setAttribute('aria-hidden', 'true');
      li.append(document.createElement('span'), document.createElement('span'));
      return li;
    }));
    list.setAttribute('aria-busy', 'true');
  }

  function renderError(list, state, err, retry) {
    list.replaceChildren();
    list.removeAttribute('aria-busy');
    state.className = 'list-state list-state--error';
    const p = document.createElement('p');
    p.textContent = messageFor(err, 'loading the entries');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn--card';
    btn.textContent = 'Try again';
    btn.addEventListener('click', retry);
    state.replaceChildren(p, btn);
  }

  function renderEntries(list, state, entries, { showRing, emptyText }) {
    list.removeAttribute('aria-busy');
    state.className = 'list-state';
    if (!entries.length) {
      const p = document.createElement('p');
      p.textContent = emptyText;
      state.replaceChildren(p);
      list.replaceChildren();
      return;
    }
    state.replaceChildren();
    list.replaceChildren(...entries.map((entry) => entryItem(entry, showRing)));
  }

  function entryItem(entry, showRing) {
    const li = document.createElement('li');
    li.className = 'entry';

    const head = document.createElement('div');
    head.className = 'entry__head';
    const name = document.createElement('h3');
    name.className = 'entry__name';
    name.textContent = entry.guest_name || '';
    head.append(name);
    const day = dayOf(entry.date);
    if (day) {
      const time = document.createElement('time');
      time.className = 'entry__date';
      time.dateTime = day.iso;
      time.textContent = day.label;
      head.append(time);
    }
    li.append(head);

    const rating = Math.round(Number(entry.dinner_rating) || 0);
    if (showRing || (rating >= 1 && rating <= 5)) {
      const meta = document.createElement('div');
      meta.className = 'entry__meta';
      if (showRing && /^[1-4]$/.test(entry.ring)) {
        const ring = document.createElement('span');
        ring.textContent = 'Guest ' + entry.ring;
        meta.append(ring);
      }
      if (rating >= 1 && rating <= 5) {
        const dots = document.createElement('span');
        dots.className = 'dots';
        dots.setAttribute('role', 'img');
        dots.setAttribute('aria-label', 'Dinner rated ' + rating + ' out of 5');
        for (let i = 1; i <= 5; i++) {
          const dot = document.createElement('span');
          if (i <= rating) dot.className = 'on';
          dots.append(dot);
        }
        meta.append(dots);
      }
      li.append(meta);
    }

    if (entry.comment) {
      const comment = document.createElement('p');
      comment.className = 'entry__comment';
      comment.textContent = entry.comment;
      li.append(comment);
    }
    return li;
  }

  // This ring

  const ringDialog = $('#ring-dialog');
  const ringSheet = setupDialog(ringDialog);
  const ringList = $('[data-entries]', ringDialog);
  const ringState = $('[data-state]', ringDialog);
  $('#ring-dialog-title').textContent = 'Guest ' + creds.ring;
  let ringRequest = 0;

  async function loadRing() {
    const id = ++ringRequest;
    renderSkeleton(ringList, ringState);
    try {
      const entries = await fetchAll({ filter: 'ring="' + creds.ring + '"' });
      if (id !== ringRequest) return;
      // Placeholder copy: edit the empty-state text.
      renderEntries(ringList, ringState, entries, { showRing: false, emptyText: 'No one has signed on this ring yet.' });
    } catch (err) {
      if (id === ringRequest) renderError(ringList, ringState, err, loadRing);
    }
  }

  $('#open-ring').addEventListener('click', () => { ringSheet.open(); loadRing(); });

  // Everyone

  const allDialog = $('#all-dialog');
  const allSheet = setupDialog(allDialog);
  const allList = $('[data-entries]', allDialog);
  const allState = $('[data-state]', allDialog);
  let allEntries = null;
  let allRequest = 0;

  const currentFilter = () => (allDialog.querySelector('input[name="ring-filter"]:checked') || {}).value || '';

  function renderAll() {
    const ring = currentFilter();
    const entries = ring ? allEntries.filter((e) => e.ring === ring) : allEntries;
    // Placeholder copy: edit the empty-state text.
    const emptyText = ring ? 'No one has signed on Guest ' + ring + ' yet.' : 'No one has signed yet.';
    renderEntries(allList, allState, entries, { showRing: !ring, emptyText });
  }

  async function loadAll() {
    const id = ++allRequest;
    allEntries = null;
    renderSkeleton(allList, allState);
    try {
      const entries = await fetchAll();
      if (id !== allRequest) return;
      allEntries = entries;
      renderAll();
    } catch (err) {
      if (id === allRequest) renderError(allList, allState, err, loadAll);
    }
  }

  allDialog.addEventListener('change', (e) => {
    if (e.target.name === 'ring-filter' && allEntries) {
      renderAll();
      allDialog.querySelector('.sheet__body').scrollTop = 0;
    }
  });

  $('#open-all').addEventListener('click', () => { allSheet.open(); loadAll(); });
})();
