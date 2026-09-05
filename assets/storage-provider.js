// storage-provider.js
/* Dual backend: GitHub + GitLab service storage */
(() => {
  'use strict';

  const PROVIDER_KEY = 'atlas_f70_provider_v1';
  const TOKEN_KEY = 'atlas_f70_service_token_v1';

  const PROVIDERS = Object.freeze({
    github: Object.freeze({
      id: 'github',
      label: 'GitHub',
      host: 'https://api.github.com',
      owner: 'JahadGhasem98',
      repo: 'RasadNegar',
      branch: 'main',
      webBase: 'https://github.com/JahadGhasem98/RasadNegar',
      tokenHelp: 'Personal Access Token با دسترسی repo',
    }),
    gitlab: Object.freeze({
      id: 'gitlab',
      label: 'GitLab',
      host: 'http://gitlab.faraabin.ir',
      project: 'fb_git_amirmahdi/checklist',
      branch: 'main',
      webBase: 'http://gitlab.faraabin.ir/fb_git_amirmahdi/checklist',
      tokenHelp: 'Personal Access Token با دسترسی api',
    }),
  });

  class ApiError extends Error {
    constructor(status) {
      super(`Storage HTTP ${status}`);
      this.status = status;
    }
  }

  function getProviderId() {
    const saved = sessionStorage.getItem(PROVIDER_KEY) || localStorage.getItem(PROVIDER_KEY);
    return saved === 'github' ? 'github' : 'gitlab';
  }

  function setProviderId(id) {
    const next = id === 'github' ? 'github' : 'gitlab';
    sessionStorage.setItem(PROVIDER_KEY, next);
    localStorage.setItem(PROVIDER_KEY, next);
    return next;
  }

  function provider() {
    return PROVIDERS[getProviderId()];
  }

  function getToken() {
    return sessionStorage.getItem(TOKEN_KEY) || '';
  }

  function setToken(token) {
    const value = String(token || '').trim();
    if (value) sessionStorage.setItem(TOKEN_KEY, value);
    else sessionStorage.removeItem(TOKEN_KEY);
    return value;
  }

  async function api(path, options = {}) {
    const p = provider();
    const token = options.token != null ? options.token : getToken();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000);
    try {
      let url;
      let headers = {
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      };

      if (p.id === 'github') {
        url = `${p.host}${path}`;
        headers = {
          ...headers,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        };
      } else {
        url = `${p.host}/api/v4${path}`;
        headers = {
          ...headers,
          ...(token ? { 'PRIVATE-TOKEN': token } : {}),
        };
      }

      const response = await fetch(url, {
        method: options.method || 'GET',
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
        signal: controller.signal,
        headers,
        ...(options.body ? { body: JSON.stringify(options.body) } : {}),
      });
      if (!response.ok) throw new ApiError(response.status);
      if (response.status === 204) return null;
      const text = await response.text();
      if (!text) return null;
      return JSON.parse(text);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new Error(`پاسخ معتبر از ${p.label} دریافت نشد. اتصال شبکه و توکن را بررسی کنید.`);
    } finally {
      clearTimeout(timeout);
    }
  }

  function encodePath(path) {
    return String(path).split('/').map(encodeURIComponent).join('/');
  }

  async function ensureProject(token) {
    const p = provider();
    if (p.id === 'github') {
      const repo = await api(`/repos/${p.owner}/${p.repo}`, { token });
      return { id: repo.id, ref: p };
    }
    const project = await api(`/projects/${encodeURIComponent(p.project)}`, { token });
    return { id: project.id, ref: p };
  }

  async function readFile(path, token) {
    const p = provider();
    try {
      if (p.id === 'github') {
        const file = await api(`/repos/${p.owner}/${p.repo}/contents/${encodePath(path)}?ref=${encodeURIComponent(p.branch)}`, { token });
        if (!file || typeof file.content !== 'string') return null;
        const bytes = Uint8Array.from(atob(file.content.replace(/\s/g, '')), c => c.charCodeAt(0));
        const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
        return { text, sha: file.sha || null };
      }
      const project = await api(`/projects/${encodeURIComponent(p.project)}`, { token });
      const file = await api(
        `/projects/${project.id}/repository/files/${encodeURIComponent(path)}?ref=${encodeURIComponent(p.branch)}`,
        { token }
      );
      if (!file || typeof file.content !== 'string') return null;
      const bytes = Uint8Array.from(atob(file.content.replace(/\s/g, '')), c => c.charCodeAt(0));
      const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
      return { text, sha: file.last_commit_id || file.blob_id || null };
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  }

  async function writeFile(path, content, message, sha, token) {
    const p = provider();
    if (p.id === 'github') {
      const encoded = btoa(unescape(encodeURIComponent(content)));
      const body = {
        message,
        content: encoded,
        branch: p.branch,
      };
      if (sha) body.sha = sha;
      const result = await api(`/repos/${p.owner}/${p.repo}/contents/${encodePath(path)}`, {
        method: 'PUT',
        body,
        token,
      });
      return { sha: result?.content?.sha || result?.commit?.sha || null };
    }

    const project = await api(`/projects/${encodeURIComponent(p.project)}`, { token });
    const action = sha ? 'update' : 'create';
    const body = {
      branch: p.branch,
      commit_message: message,
      actions: [
        {
          action,
          file_path: path,
          content,
          encoding: 'text',
          ...(sha ? { last_commit_id: sha } : {}),
        },
      ],
    };
    const commit = await api(`/projects/${project.id}/repository/commits`, {
      method: 'POST',
      body,
      token,
    });
    const fresh = await readFile(path, token);
    return { sha: fresh?.sha || commit?.id || null };
  }

  async function listMarkdown(directory, token) {
    const p = provider();
    const files = [];
    if (p.id === 'github') {
      let batch;
      try {
        batch = await api(`/repos/${p.owner}/${p.repo}/contents/${encodePath(directory)}?ref=${encodeURIComponent(p.branch)}`, { token });
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return files;
        throw error;
      }
      if (!Array.isArray(batch)) return files;
      for (const file of batch) {
        if (file.type === 'file' && file.name.endsWith('.md')) {
          files.push({ name: file.name, path: file.path, type: 'blob', sha: file.sha });
        }
      }
      return files;
    }

    const project = await api(`/projects/${encodeURIComponent(p.project)}`, { token });
    for (let page = 1; ; page++) {
      let batch;
      try {
        batch = await api(
          `/projects/${project.id}/repository/tree?path=${encodeURIComponent(directory)}&ref=${encodeURIComponent(p.branch)}&per_page=100&page=${page}`,
          { token }
        );
      } catch (error) {
        if (error instanceof ApiError && error.status === 404 && page === 1) return files;
        throw error;
      }
      if (!Array.isArray(batch)) break;
      files.push(
        ...batch
          .filter(file => file.type === 'blob' && file.name.endsWith('.md') && file.path === `${directory}/${file.name}`)
          .map(file => ({ name: file.name, path: file.path, type: 'blob', sha: file.id }))
      );
      if (batch.length < 100) break;
    }
    return files;
  }

  function webFileUrl(path) {
    const p = provider();
    if (p.id === 'github') return `${p.webBase}/blob/${p.branch}/${path}`;
    return `${p.webBase}/-/blob/${p.branch}/${path}`;
  }

  function webCommitUrl(sha) {
    const p = provider();
    if (p.id === 'github') return `${p.webBase}/commit/${sha}`;
    return `${p.webBase}/-/commit/${sha}`;
  }

  function webTreeUrl(directory) {
    const p = provider();
    if (p.id === 'github') return `${p.webBase}/tree/${p.branch}/${directory}`;
    return `${p.webBase}/-/tree/${p.branch}/${directory}`;
  }

  function explain(error) {
    if (!(error instanceof ApiError)) return error.message;
    const map = {
      400: 'درخواست نامعتبر بود.',
      401: 'توکن نامعتبر یا منقضی است.',
      403: 'اجازهٔ دسترسی ندارید یا محدودیت نرخ API فعال است.',
      404: 'مخزن یا فایل پیدا نشد.',
      409: 'فایل هم‌زمان تغییر کرده است.',
      422: 'ثبت فایل ممکن نشد.',
      429: 'تعداد درخواست‌ها زیاد است.',
    };
    return map[error.status] || `خطای ${error.status} از سرویس ذخیره‌سازی.`;
  }

  window.AtlasStorage = {
    PROVIDERS,
    ApiError,
    getProviderId,
    setProviderId,
    provider,
    getToken,
    setToken,
    api,
    ensureProject,
    readFile,
    writeFile,
    listMarkdown,
    webFileUrl,
    webCommitUrl,
    webTreeUrl,
    explain,
  };
})();