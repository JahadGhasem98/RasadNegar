/* Persian civil calendar, using the browser's ICU calendar and UTC day arithmetic. */
(() => {
  'use strict';
  const DAY = 86400000;
  const months = ['فروردین','اردیبهشت','خرداد','تیر','مرداد','شهریور','مهر','آبان','آذر','دی','بهمن','اسفند'];
  const formatter = new Intl.DateTimeFormat('en-u-ca-persian-nu-latn', { year: 'numeric', month: 'numeric', day: 'numeric', timeZone: 'UTC' });
  const fa = value => Number(value).toLocaleString('fa-IR', { useGrouping: false });
  const parts = date => Object.fromEntries(formatter.formatToParts(date).filter(p => ['year','month','day'].includes(p.type)).map(p => [p.type, Number(p.value)]));
  const starts = new Map();
  function start(year) {
    if (!starts.has(year)) {
      let date = Date.UTC(year + 621, 2, 15, 12);
      for (let i = 0; i < 15; i++, date += DAY) {
        const p = parts(date);
        if (p.year === year && p.month === 1 && p.day === 1) { starts.set(year, date); break; }
      }
    }
    if (!starts.has(year)) throw new Error('Unsupported Persian calendar year');
    return starts.get(year);
  }
  const monthStart = (year, month) => start(year) + (month <= 7 ? (month - 1) * 31 : 186 + (month - 7) * 30) * DAY;
  const length = (year, month) => month < 7 ? 31 : month < 12 ? 30 : (start(year + 1) - monthStart(year, 12)) / DAY;
  const latin = text => text.replace(/[۰-۹]/g, c => String(c.charCodeAt(0) - 1776)).replace(/[٠-٩]/g, c => String(c.charCodeAt(0) - 1632));
  function parse(text) {
    const match = latin(text.trim()).match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
    if (!match) return null;
    const [year, month, day] = match.slice(1).map(Number);
    if (year < 1200 || year > 1600 || month < 1 || month > 12 || day < 1 || day > length(year, month)) return null;
    return { year, month, day };
  }
  function today() {
    const iran = new Intl.DateTimeFormat('en-u-ca-persian-nu-latn', { timeZone: 'Asia/Tehran', year: 'numeric', month: 'numeric', day: 'numeric' });
    return Object.fromEntries(iran.formatToParts(new Date()).filter(p => ['year','month','day'].includes(p.type)).map(p => [p.type, Number(p.value)]));
  }
  const popup = document.createElement('div');
  popup.id = 'persian-calendar';
  popup.className = 'persian-calendar';
  popup.setAttribute('role', 'dialog');
  popup.setAttribute('aria-label', 'انتخاب تاریخ شمسی');
  popup.dir = 'rtl';
  popup.hidden = true;
  popup.innerHTML = `<div class="calendar-caption"><span>تقویم شمسی</span><button type="button" class="calendar-close" aria-label="بستن تقویم">×</button></div>
    <div class="calendar-navigation"><button type="button" class="calendar-prev" aria-label="ماه قبل">‹</button><select class="calendar-month" aria-label="ماه"></select><select class="calendar-year" aria-label="سال"></select><button type="button" class="calendar-next" aria-label="ماه بعد">›</button></div>
    <div class="calendar-week" aria-hidden="true"><span>ش</span><span>ی</span><span>د</span><span>س</span><span>چ</span><span>پ</span><span>ج</span></div>
    <div class="calendar-days" role="group" aria-label="روزهای ماه"></div><div class="calendar-footer"><button type="button" class="calendar-today">امروز</button><span class="calendar-today-label"></span><button type="button" class="calendar-clear">پاک‌کردن</button></div>`;
  document.body.append(popup);
  const monthSelect = popup.querySelector('.calendar-month');
  const yearSelect = popup.querySelector('.calendar-year');
  months.forEach((name, index) => monthSelect.add(new Option(name, index + 1)));
  for (let year = 1200; year <= 1600; year++) yearSelect.add(new Option(fa(year), year));
  let input = null;
  let view = today();
  let suppressFocus = false;

  function position() {
    if (!input || popup.hidden) return;
    const rect = input.getBoundingClientRect();
    if (rect.bottom < 0 || rect.top > innerHeight) return close();
    const width = popup.offsetWidth;
    const height = popup.offsetHeight;
    popup.style.left = `${Math.max(12, Math.min(innerWidth - width - 12, rect.right - width))}px`;
    popup.style.top = `${Math.max(12, rect.bottom + height + 12 <= innerHeight ? rect.bottom + 8 : rect.top - height - 8)}px`;
  }
  function close(restore = false) {
    popup.hidden = true;
    if (input) input.setAttribute('aria-expanded', 'false');
    if (restore && input) {
      suppressFocus = true;
      input.focus({ preventScroll: true });
      suppressFocus = false;
    }
  }
  function choose(value) {
    if (!input || input.disabled || input.readOnly) return close();
    input.value = value ? `${value.year}/${String(value.month).padStart(2,'0')}/${String(value.day).padStart(2,'0')}` : '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    close(true);
  }
  function draw(focusDay) {
    monthSelect.value = view.month;
    yearSelect.value = view.year;
    const now = today();
    const selected = parse(input?.value || '');
    const days = popup.querySelector('.calendar-days');
    days.replaceChildren();
    const offset = (new Date(monthStart(view.year, view.month)).getUTCDay() + 1) % 7;
    for (let i = 0; i < offset; i++) { const blank = document.createElement('span'); blank.setAttribute('aria-hidden','true'); days.append(blank); }
    for (let day = 1; day <= length(view.year, view.month); day++) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.day = day;
      button.textContent = fa(day);
      button.setAttribute('aria-label', `${fa(day)} ${months[view.month - 1]} ${fa(view.year)}`);
      if ((offset + day - 1) % 7 === 6) button.classList.add('friday');
      if (now.year === view.year && now.month === view.month && now.day === day) { button.classList.add('today'); button.setAttribute('aria-current','date'); }
      if (selected?.year === view.year && selected.month === view.month && selected.day === day) { button.classList.add('selected'); button.setAttribute('aria-pressed','true'); }
      button.addEventListener('click', () => choose({ ...view, day }));
      button.addEventListener('keydown', event => {
        const shift = { ArrowRight: -1, ArrowLeft: 1, ArrowUp: -7, ArrowDown: 7 }[event.key];
        if (shift === undefined) return;
        event.preventDefault();
        const target = parts(monthStart(view.year, view.month) + (day - 1 + shift) * DAY);
        if (target.year < 1200 || target.year > 1600) return;
        view = target;
        draw(target.day);
      });
      days.append(button);
    }
    popup.querySelector('.calendar-today-label').textContent = `${fa(now.day)} ${months[now.month - 1]} ${fa(now.year)}`;
    popup.querySelector('.calendar-prev').disabled = view.year === 1200 && view.month === 1;
    popup.querySelector('.calendar-next').disabled = view.year === 1600 && view.month === 12;
    position();
    if (focusDay) days.querySelector(`[data-day="${focusDay}"]`)?.focus();
  }
  function open(el) {
    if (suppressFocus || el.disabled || el.readOnly) return;
    if (input && input !== el) input.setAttribute('aria-expanded','false');
    input = el;
    view = parse(el.value) || today();
    popup.hidden = false;
    el.setAttribute('aria-expanded','true');
    draw();
  }
  function moveMonth(delta) {
    let month = view.month + delta;
    let year = view.year;
    if (month < 1) { month = 12; year--; }
    if (month > 12) { month = 1; year++; }
    if (year < 1200 || year > 1600) return;
    view = { year, month, day: 1 };
    draw();
  }
  popup.querySelector('.calendar-prev').addEventListener('click', () => moveMonth(-1));
  popup.querySelector('.calendar-next').addEventListener('click', () => moveMonth(1));
  popup.querySelector('.calendar-close').addEventListener('click', () => close(true));
  popup.querySelector('.calendar-today').addEventListener('click', () => choose(today()));
  popup.querySelector('.calendar-clear').addEventListener('click', () => choose(null));
  [monthSelect, yearSelect].forEach(select => select.addEventListener('change', () => { view = { year: Number(yearSelect.value), month: Number(monthSelect.value), day: 1 }; draw(); }));
  popup.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); close(true); } });
  document.addEventListener('pointerdown', event => { if (!popup.contains(event.target) && event.target !== input) close(); });
  document.addEventListener('focusin', event => { if (!popup.contains(event.target) && event.target !== input) close(); });
  window.addEventListener('resize', position);
  window.addEventListener('scroll', () => { if (!popup.hidden) position(); }, true);
  window.ChecklistCalendar = {
    close,
    attach(elements) {
      for (const el of elements) {
        el.setAttribute('aria-haspopup','dialog');
        el.setAttribute('aria-controls', popup.id);
        el.setAttribute('aria-expanded','false');
        el.placeholder = '۱۴۰۵/۰۶/۱۱';
        el.autocomplete = 'off';
        el.addEventListener('focus', () => open(el));
        el.addEventListener('click', () => open(el));
        el.addEventListener('keydown', event => {
          if (event.key === 'Escape') close();
          if (event.key === 'ArrowDown' || event.key === 'Enter') { event.preventDefault(); open(el); draw(parse(el.value)?.day || 1); }
        });
      }
    },
  };
})();
