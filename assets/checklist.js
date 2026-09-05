/* Browser-only GitLab repository storage. Credentials deliberately stay in memory. */
(() => {
  'use strict';
  /* Platform brand: رصدنگار. Projects are selectable cards; records live under records/<id>. */
  const PROJECTS_KEY = 'atlas_f70_projects_v1';
  const DEFAULT_PROJECTS = {
    'atlas-f70': {
      id: 'atlas-f70',
      name: 'Atlas F70',
      titleFa: 'چک‌لیست پروژه Atlas F70',
      directory: 'records/atlas-f70',
      markdownTitle: 'رصدنگار — چک‌لیست پروژه Atlas F70',
    },
  };

  function loadProjectsMap() {
    let map = { ...DEFAULT_PROJECTS };
    try {
      const raw = localStorage.getItem(PROJECTS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          for (const [id, item] of Object.entries(parsed)) {
            if (item && typeof item === 'object' && item.name) {
              map[id] = {
                id: item.id || id,
                name: item.name,
                titleFa: item.titleFa || `چک‌لیست پروژه ${item.name}`,
                directory: item.directory || `records/${id}`,
                markdownTitle: item.markdownTitle || `رصدنگار — چک‌لیست پروژه ${item.name}`,
                formTemplate: item.formTemplate || 'f70',
              };
            }
          }
        }
      }
    } catch (error) {
      console.warn('loadProjectsMap', error);
    }
    // Always keep default project
    if (!map['atlas-f70']) map['atlas-f70'] = { ...DEFAULT_PROJECTS['atlas-f70'] };
    return map;
  }

  function saveProjectsMap(map) {
    const clean = {};
    for (const [id, item] of Object.entries(map || {})) {
      if (item && item.name) clean[id] = item;
    }
    if (!clean['atlas-f70']) clean['atlas-f70'] = { ...DEFAULT_PROJECTS['atlas-f70'] };
    localStorage.setItem(PROJECTS_KEY, JSON.stringify(clean));
  }

  let projectsMap = loadProjectsMap();
  let activeProjectId = null;
  let activeProject = null;

  const CONFIG = {
    get directory() { return activeProject ? activeProject.directory : 'records/atlas-f70'; },
    brandName: 'رصدنگار',
    get activeProjectId() { return activeProjectId; },
    get webBase() { return window.AtlasStorage ? window.AtlasStorage.provider().webBase : ''; },
    get branch() { return window.AtlasStorage ? window.AtlasStorage.provider().branch : 'main'; },
  };

  function storage() {
    if (!window.AtlasStorage) throw new Error('ماژول ذخیره‌سازی بارگذاری نشده است.');
    return window.AtlasStorage;
  }
  const $ = id => document.getElementById(id);
  const content = $('checklist-content');
  const fields = content ? [...content.querySelectorAll('input[id], textarea[id], select[id]')] : [];
  let token = '';
  let projectId = null;
  let busy = false;
  let baseline = null;
  let pendingWrite = null;
  let cleanData = null;
  let catalog = [];
  let catalogEpoch = 0;
  let selectedFile = '';
  let currentUser = null;
  let appStarted = false;

  class ApiError extends Error {
    constructor(status) {
      super(`GitLab HTTP ${status}`);
      this.status = status;
    }
  }

  function message(text, kind = 'info') {
    const status = $('status-msg');
    if (status) {
      status.textContent = text || '';
      status.dataset.kind = kind;
    }
    const links = $('saved-links');
    if (links) links.replaceChildren();
    const adminMsg = $('admin-message');
    if (adminMsg && text) {
      adminMsg.hidden = false;
      adminMsg.textContent = text;
      adminMsg.dataset.kind = kind;
    }
  }

  function badge(text) { $('load-badge').textContent = text; updateProgress(); }

  function updateProgress() {
    const statuses = fields.filter(el => el.id.endsWith('_status'));
    const done = statuses.filter(el => el.checked).length;
    $('progress-value').textContent = `${done.toLocaleString('fa-IR')} از ${statuses.length.toLocaleString('fa-IR')} مرحله`;
    $('progress-bar').value = done;
    $('progress-bar').max = statuses.length;
  }

  function readFields() {
    return Object.fromEntries(fields.map(el => [el.id, el.type === 'checkbox' ? el.checked : el.value]));
  }

  function isDirty() {
    if (!cleanData) return false;
    const current = readFields();
    const previous = JSON.parse(cleanData);
    return fields.some(el => el.id !== 'p1_sn' && current[el.id] !== previous[el.id]);
  }

  function normalizeSerial(value) {
    const serial = value.trim().normalize('NFC')
      .replace(/[۰-۹]/g, char => String(char.charCodeAt(0) - 0x06f0))
      .replace(/[٠-٩]/g, char => String(char.charCodeAt(0) - 0x0660));
    if (!/^[\p{L}\p{N}][\p{L}\p{N}._-]{0,79}$/u.test(serial) || serial.includes('..')) {
      throw new Error('شماره‌سریال را وارد کنید؛ حداکثر ۸۰ حرف یا عدد، نقطه، خط تیره یا زیرخط. فاصله و / مجاز نیست.');
    }
    return serial;
  }

  function serialValue() {
    const serial = normalizeSerial($('search_sn').value);
    $('search_sn').value = serial;
    $('p1_sn').value = serial;
    return serial;
  }

  function pathFor(serial) { return `${CONFIG.directory}/${serial}.md`; }

  async function api(path, options = {}) {
    return storage().api(path, { ...options, token });
  }

  function explain(error) {
    return storage().explain(error);
  }

  async function withBusy(action) {
    if (busy) return;
    busy = true;
    window.ChecklistCalendar?.close();
    const controls = [...document.querySelectorAll('input, textarea, select, button')];
    const previous = controls.map(el => el.disabled);
    controls.forEach(el => { el.disabled = true; });
    $('submitBtn').setAttribute('aria-busy', 'true');
    try { await action(); }
    catch (error) { message(explain(error), 'error'); }
    finally {
      controls.forEach((el, index) => { el.disabled = previous[index]; });
      $('submitBtn').removeAttribute('aria-busy');
      busy = false;
    }
  }

  function requireConnection() {
    if (token && projectId) return true;
    $('connection-panel').open = true;
    $('service-token-sidebar')?.focus();
    message('ابتدا در بخش اتصال، توکن شخصی گیت‌هاب را وارد کنید. سپس دوباره ثبت یا بارگذاری را بزنید.', 'error');
    return false;
  }

  async function connect() {
    if (currentUser?.role !== 'admin') {
      message('فقط مدیریت می‌تواند توکن سرویس را تغییر دهد.', 'error');
      return;
    }
    const candidate = ($('service-token-sidebar') || $('service-token-sidebar'))?.value?.trim() || '';
    if ($('service-token-sidebar')) $('service-token-sidebar').value = '';
    if ($('service-token-sidebar')) $('service-token-sidebar').value = '';
    if (!candidate) { message('توکن دسترسی را وارد کنید.', 'error'); return; }
    await withBusy(async () => {
      ++catalogEpoch;
      catalog = [];
      renderCatalog();
      token = candidate;
      projectId = null;
      storage().setToken(token);
      message(`در حال بررسی دسترسی ${storage().provider().label}…`);
      const info = await storage().ensureProject(token);
      projectId = info.id;
      sessionStorage.setItem('atlas_f70_service_token_v1', token);
      $('connection-state').textContent = `متصل به ${storage().provider().label}`;
      message(`اتصال به ${storage().provider().label} برقرار شد.`, 'success');
      await refreshCatalog();
    });
  }

  function disconnect() {
    token = '';
    projectId = null;
    $('service-token-sidebar').value = '';
    $('connection-state').textContent = 'متصل نیست';
    $('connection-panel').open = true;
    message('اتصال قطع شد و توکن از حافظهٔ صفحه حذف شد. اطلاعات فرم همچنان در صفحه است.');
    catalog = [];
    renderCatalog();
    refreshCatalog();
  }

  function renderCatalog() {
    const query = $('file-search').value.trim().toLocaleLowerCase();
    const matches = catalog.filter(file => file.name.toLocaleLowerCase().includes(query));
    $('file-count').textContent = catalog.length.toLocaleString('fa-IR');
    $('file-list').replaceChildren();
    for (const file of matches) {
      const row = document.createElement('li');
      row.className = 'file-row';
      row.classList.toggle('is-selected', selectedFile === file.name);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'file-item';
      button.dataset.filename = file.name;
      button.setAttribute('aria-label', `فایل ${file.name}؛ دوبارکلیک برای بازکردن`);
      button.setAttribute('aria-pressed', String(selectedFile === file.name));
      const icon = document.createElement('span');
      icon.className = 'file-icon';
      icon.textContent = 'MD';
      const title = document.createElement('span');
      title.className = 'file-name';
      title.dir = 'auto';
      title.textContent = file.name;
      button.append(icon, title);
      button.addEventListener('click', () => {
        selectedFile = file.name;
        $('file-list').querySelectorAll('.file-row').forEach(item => item.classList.toggle('is-selected', item === row));
        $('file-list').querySelectorAll('.file-item').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
      });
      button.addEventListener('dblclick', () => openCatalogFile(file));
      button.addEventListener('keydown', event => {
        if (event.key === 'Enter') { event.preventDefault(); openCatalogFile(file); }
      });
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'file-open';
      open.textContent = 'بازکردن';
      open.setAttribute('aria-label', `بازکردن ${file.name}`);
      open.addEventListener('click', () => openCatalogFile(file));
      row.append(button, open);
      $('file-list').append(row);
    }
    $('file-empty').hidden = matches.length > 0;
    $('file-empty').textContent = query ? 'فایلی با این نام پیدا نشد.' : 'هنوز چک‌لیستی ثبت نشده است. اولین فرم را ثبت کنید.';
  }

  async function refreshCatalog() {
    const epoch = ++catalogEpoch;
    $('catalog-status').textContent = 'در حال دریافت فایل‌ها…';
    $('catalog-status').dataset.kind = 'info';
    $('refresh-files').setAttribute('aria-busy', 'true');
    try {
      if (!token) { const err = new storage().ApiError(401); throw err; }
      const files = await storage().listMarkdown(CONFIG.directory, token);
      if (epoch !== catalogEpoch) return;
      catalog = [...new Map(files.map(file => [file.name, file])).values()].sort((a, b) => a.name.localeCompare(b.name, 'fa', { numeric: true }));
      renderCatalog();
      $('catalog-status').textContent = `به‌روز شد · ${new Date().toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' })} · ${storage().provider().label}`;
    } catch (error) {
      if (epoch !== catalogEpoch) return;
      $('catalog-status').dataset.kind = 'error';
      $('catalog-status').textContent = error && error.status && [401,403,404].includes(error.status)
        ? 'برای مشاهدهٔ فایل‌ها توکن سرویس را تنظیم کنید.' : 'دریافت فهرست انجام نشد؛ دوباره تازه‌سازی کنید.';
      if (!catalog.length) { $('file-empty').hidden = false; $('file-empty').textContent = 'فهرست فایل‌ها در دسترس نیست.'; }
    } finally {
      if (epoch === catalogEpoch) $('refresh-files').removeAttribute('aria-busy');
    }
  }

  function openCatalogFile(file) {
    if (busy) return;
    try {
      const serial = file.name.slice(0, -3);
      if (normalizeSerial(serial) !== serial) throw new Error('نام این فایل با شماره‌سریال فرم سازگار نیست؛ آن را از پیوند پوشه در گیت‌هاب باز کنید.');
      loadRecord(serial);
    } catch (error) { message(error.message, 'error'); }
  }

  async function getFile(serial) {
    try {
      const file = await storage().readFile(pathFor(serial), token);
      if (!file) return null;
      return { serial, sha: file.sha, markdown: file.text };
    } catch (error) {
      if (error && error.status === 404) return null;
      throw error;
    }
  }

  function parseRecord(markdown, serial) {
    const match = markdown.match(/<!-- CHECKLIST_DATA_V1\s*\n([\s\S]*?)\nCHECKLIST_DATA_END -->/);
    if (!match) throw new Error('فایل موجود، دادهٔ قابل بارگذاری این فرم را ندارد. فایل را در گیت‌هاب بررسی کنید؛ بازنویسی خودکار انجام نمی‌شود.');
    let record;
    try { record = JSON.parse(match[1]); }
    catch { throw new Error('دادهٔ فرم در فایل معتبر نیست؛ فایل موجود بازنویسی نمی‌شود.'); }
    if (record.schemaVersion !== 1 || record.serial !== serial || !record.fields || typeof record.fields !== 'object' || Array.isArray(record.fields)) {
      throw new Error('نسخه یا شماره‌سریال دادهٔ فایل با این فرم سازگار نیست.');
    }
    if (Object.keys(record.fields).some(id => !fields.some(el => el.id === id))) {
      throw new Error('فایل شامل فیلدهایی است که در این نسخهٔ فرم وجود ندارند. ابتدا آخرین نسخهٔ فرم را باز کنید.');
    }
    for (const el of fields) {
      if (!(el.id in record.fields)) continue; // Newly added form fields start empty.
      const expected = el.type === 'checkbox' ? 'boolean' : 'string';
      if (typeof record.fields[el.id] !== expected) throw new Error('نوع یکی از مقادیر ذخیره‌شده نامعتبر است؛ فرم تغییر نکرد.');
    }
    if (record.fields.p1_sn !== serial) throw new Error('شماره‌سریال داخل فایل همخوانی ندارد.');
    return record.fields;
  }

  function fillFields(data) {
    for (const el of fields) {
      if (el.type === 'checkbox') el.checked = data[el.id] ?? false;
      else el.value = data[el.id] ?? '';
    }
  }

  async function loadRecord(requestedSerial) {
    await withBusy(async () => {
      const serial = normalizeSerial(typeof requestedSerial === 'string' ? requestedSerial : $('search_sn').value);
      if (isDirty() && !window.confirm('بارگذاری، مقادیر فعلی فرم را جایگزین می‌کند. ادامه می‌دهید؟')) return;
      message('در حال خواندن فایل Markdown از گیت‌هاب…');
      const file = await getFile(serial);
      if (!file) {
        await storage().ensureProject(token);
        if (requestedSerial) {
          refreshCatalog();
          throw new Error('این فایل دیگر در پوشه موجود نیست. اطلاعات فعلی فرم حفظ شد.');
        }
        baseline = { serial, sha: null };
        badge('فایل قبلی یافت نشد؛ آمادهٔ ثبت جدید');
        message('برای این شماره‌سریال فایلی وجود ندارد. مقادیر فعلی فرم حفظ شده‌اند؛ پیش از ثبت آن‌ها را بررسی کنید.');
        return;
      }
      const data = parseRecord(file.markdown, serial);
      fillFields(data);
      $('search_sn').value = serial;
      baseline = file;
      pendingWrite = null;
      cleanData = JSON.stringify(readFields());
      badge(`سوابق سریال ${serial} بارگذاری شد`);
      message('اطلاعات قبلی بارگذاری شد. تغییرات را وارد کنید و ثبت را بزنید.', 'success');
      showLinks(serial, file.sha);
      selectedFile = `${serial}.md`;
      renderCatalog();
      $('editor-heading').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  // Escape both Markdown and HTML so typed text cannot change table structure or inject markup.
  function escapeText(value) {
    const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '\\': '&#92;', '|': '&#124;' };
    return String(value).replace(/[&<>\\|*_`\[\]#!]/g, char => entities[char] || `\\${char}`)
      .replace(/\r?\n/g, '<br>');
  }

  function renderNode(node) {
    if (node.nodeType === Node.TEXT_NODE) return escapeText(node.textContent.replace(/\s+/g, ' '));
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    if (node.matches('.bd-main, script, style')) return '';
    if (node.matches('input, textarea, select')) {
      return node.type === 'checkbox' ? (node.checked ? '☑' : '☐') : (escapeText(node.value) || '—');
    }
    if (node.tagName === 'BR') return '<br>';
    const text = [...node.childNodes].map(renderNode).join('');
    return node.tagName === 'DIV' ? `${text}<br>` : text;
  }

  function cellText(node) { return renderNode(node).trim().replace(/(?:<br>\s*)+$/, '').trim(); }

  function makeMarkdown(serial) {
    const lines = [
      '<div dir="rtl">', '',
      `# ${(activeProject && activeProject.markdownTitle) || "رصدنگار"} — شماره‌سریال: ${escapeText(serial)}`, '',
      '> ☑ انتخاب شده / ☐ انتخاب نشده — تاریخ‌ها مطابق مقدار شمسی واردشده در فرم هستند.', '',
    ];
    for (const el of content.children) {
      if (el.classList.contains('section-header')) lines.push(`## ${cellText(el)}`, '');
      else if (el.classList.contains('sub-title')) lines.push(`### ${cellText(el)}`, '');
      else if (el.tagName === 'TABLE' || el.classList.contains('table-scroll')) {
        const rows = [...(el.tagName === 'TABLE' ? el : el.querySelector('table')).rows];
        rows.forEach((row, index) => {
          lines.push(`| ${[...row.cells].map(cellText).join(' | ')} |`);
          if (index === 0) lines.push(`| ${[...row.cells].map(() => '---:').join(' | ')} |`);
        });
        lines.push('');
      } else if (el.classList.contains('footer-sign')) {
        lines.push('### تأییدها', '', '| عنوان | نام / تأیید |', '| ---: | ---: |');
        for (const group of el.children) {
          lines.push(`| ${cellText(group.querySelector('label'))} | ${cellText(group.querySelector('input'))} |`);
        }
        lines.push('');
      } else if (el.classList.contains('notice')) lines.push(`> ${cellText(el)}`, '');
    }
    const record = { schemaVersion: 1, serial, fields: readFields() };
    // Escaping angle brackets prevents user values from terminating the metadata comment.
    const json = JSON.stringify(record, null, 2).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
    lines.push('</div>', '', '<!-- CHECKLIST_DATA_V1', json, 'CHECKLIST_DATA_END -->', '');
    return lines.join('\n');
  }

  function showLinks(serial, sha) {
    const links = [
      ['مشاهدهٔ فایل Markdown', storage().webFileUrl(pathFor(serial))],
      ['مشاهدهٔ Commit', storage().webCommitUrl(sha)],
    ];
    $('saved-links').replaceChildren();
    for (const [title, href] of links) {
      const link = document.createElement('a');
      link.textContent = title;
      link.href = href;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      $('saved-links').append(link);
    }
  }

  function saved(serial, sha, markdown) {
    baseline = { serial, sha, markdown };
    pendingWrite = null;
    cleanData = JSON.stringify(readFields());
    badge(`سریال ${serial} در مخزن ثبت شد`);
    message('فایل Markdown با موفقیت در گیت‌هاب ثبت شد.', 'success');
    showLinks(serial, sha);
    selectedFile = `${serial}.md`;
    if (!catalog.some(file => file.name === selectedFile)) catalog.push({ name: selectedFile, path: pathFor(serial), type: 'blob' });
    renderCatalog();
    refreshCatalog();
  }

  async function saveRecord() {
    if (!requireConnection()) return;
    await withBusy(async () => {
      const serial = serialValue();
      const markdown = makeMarkdown(serial);
      message('در حال بررسی آخرین نسخه و ثبت فایل در گیت‌هاب…');
      const remote = await getFile(serial);

      // A previous POST may have succeeded even if its response was lost. Reconcile before retrying.
      if (pendingWrite?.serial === serial && remote?.markdown === pendingWrite.markdown) {
        baseline = remote;
        pendingWrite = null;
      }
      if (remote) {
        if (baseline?.serial !== serial || !baseline.sha) {
          throw new Error('برای این شماره‌سریال از قبل فایل وجود دارد. برای جلوگیری از حذف سوابق، ابتدا «بارگذاری سوابق» را بزنید. مقادیر فعلی را می‌توانید قبل از آن دانلود کنید.');
        }
        if (remote.sha !== baseline.sha) throw new ApiError(409);
        if (remote.markdown === markdown) {
          saved(serial, remote.sha, markdown);
          message('اطلاعات فعلی قبلاً ثبت شده است؛ Commit تکراری ساخته نشد.', 'success');
          showLinks(serial, remote.sha);
          return;
        }
      } else if (baseline?.serial === serial && baseline.sha) {
        throw new Error('فایلی که بارگذاری کرده بودید اکنون در مخزن وجود ندارد. برای بررسی حذف یا جابه‌جایی فایل، مخزن را باز کنید.');
      }

      pendingWrite = { serial, markdown };
      const result = await storage().writeFile(
        pathFor(serial),
        markdown,
        `${remote ? 'Update' : 'Create'} ${(activeProject && activeProject.name) || 'project'} checklist: ${serial}`,
        remote ? baseline.sha : null,
        token
      );
      const newSha = result?.sha;
      if (!newSha) throw new Error('پاسخ ثبت کامل نیست. دوباره «ثبت» را بزنید تا وضعیت فایل بررسی شود.');
      saved(serial, newSha, markdown);
    });
  }

  function downloadMarkdown() {
    try {
      const serial = serialValue();
      const blob = new Blob([makeMarkdown(serial)], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${serial}.md`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      message('نسخهٔ Markdown برای دانلود آماده شد. دانلود به‌تنهایی چیزی در گیت‌هاب ثبت نمی‌کند.');
    } catch (error) { message(error.message, 'error'); }
  }

  function statusCheckboxes() {
    return fields.filter(el => el.type === 'checkbox' && el.id.endsWith('_status'));
  }

  function canCheckStatus(checkbox) {
    const list = statusCheckboxes();
    const index = list.indexOf(checkbox);
    if (index <= 0) return true;
    return list.slice(0, index).every(el => el.checked);
  }

  function applyConfirmerFromStatus(checkbox) {

    if (!checkbox || checkbox.type !== 'checkbox' || !checkbox.id.endsWith('_status')) return;
    if (!checkbox.checked || !currentUser?.username) return;
    const confId = checkbox.id.replace(/_status$/, '_conf');
    const conf = $(confId);
    if (conf && !conf.value.trim()) conf.value = currentUser.username;
  }

  function bindAppEvents() {
    $('loadBtn').addEventListener('click', () => loadRecord());
    $('submitBtn').addEventListener('click', saveRecord);
    $('downloadBtn').addEventListener('click', downloadMarkdown);
    $('refresh-files').addEventListener('click', refreshCatalog);
    $('file-search').addEventListener('input', renderCatalog);
    $('new-record').addEventListener('click', () => {
      if (busy || (isDirty() && !window.confirm('فرم جدید باز شود؟ تغییرات ثبت‌نشدهٔ فعلی پاک می‌شود.'))) return;
      fillFields({});
      $('search_sn').value = '';
      baseline = null;
      pendingWrite = null;
      selectedFile = '';
      cleanData = JSON.stringify(readFields());
      renderCatalog();
      badge('فرم جدید · آمادهٔ تکمیل');
      message('شماره‌سریال دستگاه جدید را وارد کنید.');
      $('search_sn').focus();
    });
    $('service-token-sidebar')?.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !busy) { event.preventDefault(); connect(); }
    });
    $('connectBtn').addEventListener('click', connect);
    $('disconnectBtn').addEventListener('click', disconnect);
    $('search_sn').addEventListener('input', () => {
      $('p1_sn').value = $('search_sn').value.trim();
      if (baseline?.serial !== $('search_sn').value.trim()) badge('شماره‌سریال تغییر کرده؛ سوابق را بررسی کنید');
    });
    content.addEventListener('input', () => { if (isDirty()) badge('تغییرات ثبت‌نشده'); });
    content.addEventListener('change', event => {
      const target = event.target;
      if (target && target.matches('input[type="checkbox"][id$="_status"]')) {
        if (target.checked && !canCheckStatus(target)) {
          target.checked = false;
          message('ابتدا مرحلهٔ قبلی را تأیید کنید.', 'error');
          return;
        }
        applyConfirmerFromStatus(target);
        updateProgress();
        if (isDirty()) badge('تغییرات ثبت‌نشده');
      }
    });
    window.addEventListener('beforeunload', event => {
      if (isDirty() || busy) { event.preventDefault(); event.returnValue = ''; }
    });
    $('logoutBtn').addEventListener('click', () => {
      if (isDirty() && !window.confirm('تغییرات ثبت‌نشده دارید. خارج می‌شوید؟')) return;
      if (window.AtlasAuth) window.AtlasAuth.logout();
      location.reload();
    });
    $('changePasswordBtn')?.addEventListener('click', () => {
      if (window.AtlasAuth && window.AtlasAuth.openPasswordChange) {
        window.AtlasAuth.openPasswordChange({ voluntary: true });
      }
    });
    $('back-to-projects')?.addEventListener('click', () => {
      if (isDirty() && !window.confirm('تغییرات ثبت‌نشده دارید. به فهرست پروژه‌ها برگردید؟')) return;
      showProjectHub();
    });
    $('admin-project-form')?.addEventListener('submit', event => {
      event.preventDefault();
      Promise.resolve()
        .then(() => addProjectFromAdmin())
        .catch(error => message(error.message || String(error), 'error'));
    });
  }

  function renderProjectHub() {
    const grid = $('project-grid');
    const empty = $('project-hub-empty');
    if (!grid) return;
    projectsMap = loadProjectsMap();
    grid.replaceChildren();
    const items = Object.values(projectsMap)
      .filter(project => project && project.name)
      .sort((a, b) => String(a.name).localeCompare(String(b.name), 'fa'));
    if (empty) {
      empty.hidden = items.length > 0;
      empty.textContent = items.length ? '' : 'هنوز پروژه‌ای تعریف نشده است. از پنل مدیریت پروژه اضافه کنید.';
    }
    for (const project of items) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'project-card';
      card.setAttribute('data-project-id', project.id);
      const icon = document.createElement('span');
      icon.className = 'project-card-icon';
      icon.textContent = '📁';
      const title = document.createElement('strong');
      title.textContent = project.name;
      const meta = document.createElement('small');
      meta.dir = 'ltr';
      meta.textContent = project.directory || `records/${project.id}`;
      card.append(icon, title, meta);
      card.addEventListener('click', () => openProject(project.id));
      grid.append(card);
    }
  }

  function renderAdminProjects() {
    const list = $('admin-project-list');
    if (!list) return;
    list.replaceChildren();
    for (const project of Object.values(projectsMap).sort((a, b) => a.name.localeCompare(b.name, 'fa'))) {
      const row = document.createElement('div');
      row.className = 'admin-user-row';
      const main = document.createElement('div');
      main.className = 'admin-user-main';
      const title = document.createElement('strong');
      title.textContent = project.name;
      const meta = document.createElement('span');
      meta.dir = 'ltr';
      meta.textContent = project.directory;
      main.append(title, meta);
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'btn-danger';
      del.textContent = 'حذف';
      del.disabled = project.id === 'atlas-f70';
      del.title = project.id === 'atlas-f70' ? 'پروژه پیش‌فرض قابل حذف نیست' : 'حذف پروژه';
      del.addEventListener('click', () => {
        if (project.id === 'atlas-f70') return;
        if (!window.confirm(`پروژه «${project.name}» حذف شود؟`)) return;
        delete projectsMap[project.id];
        saveProjectsMap(projectsMap);
        if (activeProjectId === project.id) showProjectHub();
        renderAdminProjects();
        renderProjectHub();
        message(`پروژه «${project.name}» حذف شد.`, 'success');
      });
      const actions = document.createElement('div');
      actions.className = 'admin-user-actions';
      actions.append(del);
      row.append(main, actions);
      list.append(row);
    }
  }

  function showProjectHub() {
    activeProjectId = null;
    activeProject = null;
    if ($('project-hub')) $('project-hub').hidden = false;
    if ($('checklist-workspace')) $('checklist-workspace').hidden = true;
    if ($('sidebar-files')) $('sidebar-files').hidden = true;
    if ($('new-record')) $('new-record').hidden = true;
    if ($('active-project-chip')) $('active-project-chip').hidden = true;
    if ($('sidebar-footer-project')) $('sidebar-footer-project').textContent = 'انتخاب پروژه';
    renderProjectHub();
  }

  function openProject(id) {
    const project = projectsMap[id];
    if (!project) return;
    activeProjectId = id;
    activeProject = project;
    if ($('project-hub')) $('project-hub').hidden = true;
    if ($('checklist-workspace')) $('checklist-workspace').hidden = false;
    if ($('sidebar-files')) $('sidebar-files').hidden = false;
    if ($('new-record')) $('new-record').hidden = false;
    if ($('active-project-chip')) $('active-project-chip').hidden = false;
    if ($('active-project-label')) $('active-project-label').textContent = project.name;
    if ($('sidebar-footer-project')) $('sidebar-footer-project').textContent = project.name;
    const link = $('folder-path-link');
    if (link) link.href = storage().webTreeUrl(project.directory);
    if ($('folder-path-label')) $('folder-path-label').textContent = project.directory.replaceAll('/', ' / ');
    const crumb = document.querySelector('#editor-heading .breadcrumb');
    if (crumb) crumb.innerHTML = `رصدنگار <span>/</span> پروژه‌ها <span>/</span> <bdi>${project.name}</bdi> <span>/</span> چک‌لیست دستگاه`;
    const h1 = document.querySelector('#editor-heading h1');
    if (h1) h1.innerHTML = `چک‌لیست پروژه <bdi>${project.name}</bdi>`;
    baseline = null;
    pendingWrite = null;
    selectedFile = '';
    fillFields({});
    if ($('search_sn')) $('search_sn').value = '';
    cleanData = JSON.stringify(readFields());
    badge('فرم جدید · آمادهٔ تکمیل');
    catalog = [];
    renderCatalog();
    refreshCatalog();
    message(`پروژه «${project.name}» باز شد.`, 'success');
  }

  function buildProjectFormHtml(project) {
    const safeName = String(project.name).replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>رصدنگار — ${safeName}</title>
  <meta http-equiv="refresh" content="0;url=../Form.html?project=${encodeURIComponent(project.id)}">
  <link rel="stylesheet" href="../assets/workspace.css">
</head>
<body>
  <div class="auth-gate">
    <div class="auth-card">
      <div class="auth-brand">
        <img class="brand-logo" src="../assets/brand/rasad-negar-logo.png" alt="لوگوی رصدنگار" width="64" height="64">
        <div>
          <strong>رصدنگار</strong>
          <small>${safeName}</small>
        </div>
      </div>
      <p class="auth-help">در حال باز کردن صفحهٔ چک‌لیست پروژه <b>${safeName}</b>…</p>
      <p class="auth-hint">اگر منتقل نشدید، <a href="../Form.html?project=${encodeURIComponent(project.id)}">اینجا را کلیک کنید</a>.</p>
    </div>
  </div>
</body>
</html>
`;
  }

  async function ensureProjectRepoFiles(project) {
    if (!token) return;
    try {
      await storage().writeFile(`${project.directory}/.gitkeep`, '', `feat(projects): init ${project.name} records`, null, token);
      await storage().writeFile(`forms/${project.id}.html`, buildProjectFormHtml(project), `feat(projects): create ${project.name} form page`, null, token);
    } catch (error) {
      console.warn('project repo files', error);
    }
  }

  function slugifyProjectId(value) {
    return String(value || '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9_-]/g, '')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40);
  }

  async function addProjectFromAdmin() {
    const name = ($('admin-project-name').value || '').trim();
    let id = ($('admin-project-id').value || '').trim().toLowerCase();
    if (!name) throw new Error('نام پروژه را وارد کنید.');
    if (!id) id = slugifyProjectId(name);
    if (!id) id = `project-${Date.now().toString(36)}`;
    if (!/^[a-z][a-z0-9_-]{0,39}$/.test(id)) {
      throw new Error('شناسه پروژه باید با حرف انگلیسی شروع شود و فقط حرف، عدد، - و _ داشته باشد.');
    }
    // Reload latest map so concurrent tabs do not overwrite.
    projectsMap = loadProjectsMap();
    if (projectsMap[id]) throw new Error('این شناسه قبلاً ثبت شده است.');
    const project = {
      id,
      name,
      titleFa: `چک‌لیست پروژه ${name}`,
      directory: `records/${id}`,
      markdownTitle: `رصدنگار — چک‌لیست پروژه ${name}`,
      formTemplate: 'f70',
      createdAt: new Date().toISOString(),
    };
    projectsMap[id] = project;
    saveProjectsMap(projectsMap);
    // Verify persistence
    projectsMap = loadProjectsMap();
    if (!projectsMap[id]) throw new Error('ذخیره پروژه در مرورگر انجام نشد.');
    if ($('admin-project-name')) $('admin-project-name').value = '';
    if ($('admin-project-id')) $('admin-project-id').value = '';
    renderAdminProjects();
    renderProjectHub();
    message(`پروژه «${name}» به فهرست اضافه شد.`, 'success');
    try {
      await ensureProjectRepoFiles(project);
    } catch (error) {
      console.warn(error);
    }
    try {
      openProject(id);
      message(`صفحه چک‌لیست «${name}» آماده است (ساختار مشابه Atlas F70).`, 'success');
    } catch (error) {
      showProjectHub();
      message(`پروژه ذخیره شد ولی باز کردن فرم با خطا روبه‌رو شد: ${error.message || error}`, 'error');
    }
  }

  async function startApp(detail) {
    if (appStarted) return;
    appStarted = true;
    currentUser = {
      username: detail.username,
      role: detail.role,
    };
    token = detail.token || (window.AtlasAuth && window.AtlasAuth.getServiceToken()) || '';
    projectId = null;
    projectsMap = loadProjectsMap();

    $('session-user-label').textContent = `${currentUser.username} · ${currentUser.role === 'admin' ? 'مدیر' : 'عضو'}`;
    $('connection-panel').hidden = currentUser.role !== 'admin';
    if (currentUser.role === 'admin' && token) {
      $('connection-state').textContent = 'توکن سرویس فعال است';
    }

    bindAppEvents();
    // Ensure project form is bound even if earlier listeners failed.
    const projectForm = $('admin-project-form');
    if (projectForm && projectForm.dataset.bound !== '1') {
      projectForm.dataset.bound = '1';
      projectForm.addEventListener('submit', event => {
        event.preventDefault();
        Promise.resolve()
          .then(() => addProjectFromAdmin())
          .catch(error => message(error.message || String(error), 'error'));
      });
    }
    document.addEventListener('atlas-service-token-updated', event => {
      token = event.detail?.token || token;
      projectId = null;
      message('توکن سرویس به‌روز شد.', 'success');
      if (activeProjectId) refreshCatalog();
    });

    $('http-notice').hidden = !(location.protocol === 'http:' || CONFIG.host.startsWith('http:'));
    if (token) {
      try {
        const info = await storage().ensureProject(token);
        projectId = info.id;
        $('connection-state').textContent = currentUser.role === 'admin'
          ? `توکن ${storage().provider().label} فعال است`
          : `متصل به ${storage().provider().label}`;
      } catch {
        $('connection-state').textContent = 'اتصال برقرار نشد';
      }
    }
    // Admin panel must appear even if remote user sync fails.
    if (currentUser.role === 'admin' && $('admin-panel')) {
      $('admin-panel').hidden = false;
    }
    try {
      if (window.AtlasAuth && typeof window.AtlasAuth.initAdminPanel === 'function') {
        await window.AtlasAuth.initAdminPanel();
      }
    } catch (error) {
      console.warn('initAdminPanel', error);
      if (currentUser.role === 'admin' && $('admin-panel')) $('admin-panel').hidden = false;
      message(error.message || 'بارگذاری پنل مدیریت با خطا روبه‌رو شد.', 'error');
    }

    projectsMap = loadProjectsMap();
    try { renderAdminProjects(); } catch (error) { console.warn(error); }
    showProjectHub();

    const requestedProject = new URLSearchParams(location.search).get('project');
    if (requestedProject && projectsMap[requestedProject]) {
      try { openProject(requestedProject); } catch (error) { console.warn(error); }
    }

    if (window.ChecklistCalendar && content) {
      try {
        window.ChecklistCalendar.attach(content.querySelectorAll('.shamsi-date'));
      } catch { if ($('calendar-notice')) $('calendar-notice').hidden = false; }
    } else if ($('calendar-notice')) {
      $('calendar-notice').hidden = false;
    }
  }

  document.addEventListener('atlas-auth-ready'
, event => {
    startApp(event.detail || {});
  });
})();
