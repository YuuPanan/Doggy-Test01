const SESSION_KEY = 'doogy.workbench.session';

export class ApiError extends Error {
  constructor(status, detail) {
    super(Array.isArray(detail.message) ? detail.message.join('；') : detail.message || '请求未完成，请稍后重试');
    this.status = status;
    this.code = detail.code || `HTTP_${status}`;
    this.requestId = detail.request_id;
  }
}

export class ApiClient {
  constructor(baseUrl = '/api/v1', storage = globalThis.sessionStorage) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.storage = storage;
    this.session = null;
    this.refreshing = null;
    try { this.session = JSON.parse(storage?.getItem(SESSION_KEY) || 'null'); }
    catch { storage?.removeItem(SESSION_KEY); }
  }
  get authenticated() { return Boolean(this.session?.access_token); }
  saveSession(value) {
    this.session = value ? { access_token: value.access_token, refresh_token: value.refresh_token } : null;
    if (this.session) this.storage?.setItem(SESSION_KEY, JSON.stringify(this.session));
    else this.storage?.removeItem(SESSION_KEY);
  }
  url(path) {
    return this.baseUrl + (path.startsWith('/api/v1/') ? path.slice('/api/v1'.length) : path);
  }
  async call(path, { method = 'GET', body, key } = {}, token) {
    const headers = new Headers();
    if (token) headers.set('Authorization', `Bearer ${token}`);
    if (key) headers.set('Idempotency-Key', key);
    const multipart = body instanceof FormData;
    if (body !== undefined && !multipart) headers.set('Content-Type', 'application/json');
    try {
      return await fetch(this.url(path), { method, headers, body: body === undefined ? undefined : multipart ? body : JSON.stringify(body) });
    } catch { throw new ApiError(0, { code: 'NETWORK_ERROR', message: '无法连接服务，请检查连接后重试' }); }
  }
  async requireOk(response) {
    if (response.ok) return response;
    let detail;
    try { detail = await response.json(); }
    catch { detail = { message: '服务暂时无法处理请求' }; }
    throw new ApiError(response.status, detail);
  }
  async refresh() {
    if (!this.refreshing) {
      this.refreshing = (async () => {
        try {
          const response = await this.requireOk(await this.call('/auth/refresh', { method: 'POST', body: { refresh_token: this.session?.refresh_token } }));
          this.saveSession(await response.json());
        } catch (error) { this.saveSession(null); throw error; }
      })().finally(() => { this.refreshing = null; });
    }
    return this.refreshing;
  }
  async response(path, options) {
    const token = this.session?.access_token;
    let result = await this.call(path, options, token);
    if (result.status === 401 && this.session?.refresh_token) {
      if (token === this.session.access_token) await this.refresh();
      result = await this.call(path, options, this.session?.access_token);
    }
    return this.requireOk(result);
  }
  async request(path, options = {}) {
    const response = await this.response(path, options);
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }
  get(path) { return this.request(path); }
  send(method, path, body, key) { return this.request(path, { method, body, key }); }
  async signIn(path, body) {
    const response = await this.requireOk(await this.call(path, { method: 'POST', body }));
    this.saveSession(await response.json());
    return this.resume();
  }
  login(body) { return this.signIn('/auth/login', body); }
  register(body) { return this.signIn('/auth/register', body); }
  async resume() {
    if (!this.authenticated) return null;
    const user = await this.get('/auth/me');
    const households = await this.get('/households');
    return { user, households: households.items };
  }
  async logout() {
    try { if (this.authenticated) await this.send('POST', '/auth/logout'); }
    finally { this.saveSession(null); }
  }
  upload(path, file, filename, key) {
    const body = new FormData();
    body.append('file', file, file.name || 'attachment');
    if (filename) body.append('filename', filename);
    return this.request(path, { method: 'POST', body, key });
  }
  async blob(path) {
    const response = await this.response(path);
    const encoded = /filename\*=UTF-8''([^;]+)/i.exec(response.headers.get('content-disposition') || '')?.[1];
    return { blob: await response.blob(), filename: encoded ? decodeURIComponent(encoded) : '附件', contentType: response.headers.get('content-type') };
  }
}
