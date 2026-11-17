const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const when = (value) => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '暂无';
const fmt = (value, unit = '') => value == null ? '—' : `${new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(value)}${unit}`;
const localInput = (value) => value ? new Date(Date.parse(value) - new Date(value).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '';
const names = { 'geofence.exited': '离开围栏', 'geofence.entered': '返回围栏', 'battery.low': '低电量', 'device.offline': '设备离线', 'location.stale': '定位过期', open: '开放', closed: '已关闭', simulated: '离线模拟', pending: '等待发送', processing: '处理中', sent: '服务商已受理', skipped: '未发送', dead: '发送失败', fresh: '新鲜', stale: '已过期', unknown: '未知', poor_accuracy: '精度不足', clock_ahead: '设备时间超前', implausible_speed: '速度异常' };
const name = (value) => names[value] ?? value ?? '暂无';
const badge = (value, warning = false) => `<span class="badge ${warning ? 'warning' : 'neutral'}">${esc(name(value))}</span>`;
const button = (text, action, id = '') => `<button class="button small" data-action="${action}"${id ? ` data-id="${esc(id)}"` : ''}>${text}</button>`;
const empty = (text) => `<div class="empty">${text}</div>`;
const panel = (title, content) => `<section class="panel"><div class="panel-head"><h2>${title}</h2></div>${content}</section>`;
const detail = (title, value) => `<div class="detail-row"><dt>${title}</dt><dd>${esc(value)}</dd></div>`;

export async function loadHistory(api, petId, { from, to, locationCursor, eventCursor } = {}) {
  const locationQuery = new URLSearchParams({ limit: '20' }), eventQuery = new URLSearchParams({ limit: '20' });
  if (from) locationQuery.set('from', from);
  if (to) locationQuery.set('to', to);
  if (locationCursor) locationQuery.set('cursor', locationCursor);
  if (eventCursor) eventQuery.set('cursor', eventCursor);
  const path = `/pets/${encodeURIComponent(petId)}`;
  const [locations, events] = await Promise.all([api.get(`${path}/locations?${locationQuery}`), api.get(`${path}/safety-events?${eventQuery}`)]);
  return { locations, events };
}

function historicalPoint(point) {
  return Number.isFinite(point.lat) && Number.isFinite(point.lon) && point.source === 'gnss'
    && point.accuracy_m != null && point.accuracy_m <= 100 && (point.quality_flags ?? []).length === 0;
}

function track(items) {
  const ordered = [...items].sort((a, b) => a.device_ts.localeCompare(b.device_ts) || a.id.localeCompare(b.id));
  const valid = ordered.filter(historicalPoint);
  if (valid.length < 2) return empty('至少需要两个质量足够的历史点才能展示轨迹示意。');
  const minLat = Math.min(...valid.map((point) => point.lat)), maxLat = Math.max(...valid.map((point) => point.lat));
  const minLon = Math.min(...valid.map((point) => point.lon)), maxLon = Math.max(...valid.map((point) => point.lon));
  const horizontal = Math.max(.01, Math.cos((minLat + maxLat) / 2 * Math.PI / 180));
  const scale = Math.max((maxLon - minLon) * horizontal / 560, (maxLat - minLat) / 200, 1e-9);
  const x = (point) => (320 + (point.lon - (minLon + maxLon) / 2) * horizontal / scale).toFixed(2);
  const y = (point) => (130 - (point.lat - (minLat + maxLat) / 2) / scale).toFixed(2);
  const segments = [];
  let previous = null;
  for (const point of ordered) {
    if (!historicalPoint(point)) { previous = null; continue; }
    if (previous && point.binding_id && point.device_id && point.binding_id === previous.binding_id && point.device_id === previous.device_id) {
      segments.push(`<line x1="${x(previous)}" y1="${y(previous)}" x2="${x(point)}" y2="${y(point)}" stroke="#7c985b" stroke-width="3"/>`);
    }
    previous = point;
  }
  const circles = valid.map((point, index) => `<circle cx="${x(point)}" cy="${y(point)}" r="${index === 0 || index === valid.length - 1 ? 5 : 3}" fill="#244b3e"><title>${esc(when(point.device_ts))} · ${esc(point.lat)}, ${esc(point.lon)}</title></circle>`).join('');
  // shortcut: local coordinates only, use a map provider when geographic navigation is required.
  return `<svg class="track-chart" viewBox="0 0 640 260" role="img" aria-label="已加载历史位置的局部坐标示意" style="display:block;width:100%;height:auto;background:#f2f4eb;border-radius:12px"><text x="18" y="24" fill="#748079" font-size="12">北 ↑</text>${segments.join('')}${circles}</svg><p class="hint">仅展示当前已加载的 ${valid.length} 个质量足够的 GNSS 点；同设备、同次绑定且中间无异常点时连线。无明确绑定归属只显示散点。此为局部坐标示意，无地图底图，不用于导航或精确距离测量。</p>`;
}

export function renderHistory(data) {
  const locations = data.locations, events = data.events;
  const range = locations.range;
  const form = `<form id="history-range-form" class="toolbar"><label>位置起始时间<input type="datetime-local" name="from" value="${esc(localInput(range.from))}" required></label><label>位置结束时间<input type="datetime-local" name="to" value="${esc(localInput(range.to))}" required></label><button class="button primary" type="submit">查询位置</button></form><p class="hint">位置按当前设备的 ${esc(Intl.DateTimeFormat().resolvedOptions().timeZone)} 输入和显示，单次最多 31 天。实际查询范围：${esc(when(range.from))} 至 ${esc(when(range.to))}（不含结束时刻）。时间范围只筛选位置；安全事件独立展示全部历史。</p>`;
  const locationRows = locations.items.map((point) => `<tr><td>${esc(when(point.device_ts))}</td><td>${esc(point.lat)}, ${esc(point.lon)}</td><td>${fmt(point.accuracy_m, ' m')}<br>${esc(point.source)}</td><td>${historicalPoint(point) ? '历史质量足够' : '历史质量不足'}<br>采样新鲜度：${esc(name(point.freshness))}${point.quality_flags?.length ? `<br>${esc(point.quality_flags.map(name).join('、'))}` : ''}</td></tr>`).join('');
  const locationTable = locations.items.length ? `<div class="table-scroll"><table><caption class="sr-only">历史位置明细</caption><thead><tr><th>采样时间</th><th>纬度 / 经度</th><th>精度 / 来源</th><th>质量 / 新鲜度</th></tr></thead><tbody>${locationRows}</tbody></table></div>` : empty('这个时间范围内还没有位置上报。');
  const eventRows = events.items.map((event) => `<div class="data-row"><div class="row-body"><div class="row-title">${esc(name(event.type))} ${badge(event.status, event.status === 'open')}</div><div class="row-note">${esc(when(event.occurred_at))}${event.closed_at ? `<br>关闭于 ${esc(when(event.closed_at))}` : ''}</div></div>${button('查看详情', 'event-detail', event.id)}</div>`).join('');
  return `<div class="stack">${panel('位置查询', form)}${panel('位置轨迹与明细', `${track(locations.items)}${locationTable}${locations.next_cursor ? `<div class="more">${button('加载更早的位置', 'history-more-locations')}</div>` : ''}<p class="hint">已加载 ${locations.items.length} 条位置。历史质量足够不代表当前仍可追踪；过期位置不表示现在的位置。</p>`)}${panel('安全事件历史', `${eventRows ? `<div class="rows">${eventRows}</div>` : empty('暂无安全事件。')}<p class="hint">已加载 ${events.items.length} 项。确认知晓不关闭事件，通知已读也不表示风险消失。</p>${events.next_cursor ? `<div class="more">${button('加载更早的事件', 'history-more-events')}</div>` : ''}`)}</div>`;
}

export function renderEventDetail(event, { canWrite = false } = {}) {
  const evidence = event.details ?? {}, location = event.location, acknowledgement = event.acknowledgement;
  const facts = [evidence.battery_pct != null && detail('事件电量', fmt(evidence.battery_pct, '%')), evidence.accuracy_m != null && detail('事件定位精度', fmt(evidence.accuracy_m, ' m')), evidence.source && detail('定位来源', evidence.source), evidence.rule_version && detail('围栏规则版本', evidence.rule_version), evidence.effective_buffer_m != null && detail('有效缓冲距离', fmt(evidence.effective_buffer_m, ' m')), evidence.last_seen_at && detail('当时最近接收', when(evidence.last_seen_at)), evidence.last_location_at && detail('当时最近定位', when(evidence.last_location_at))].filter(Boolean).join('');
  const locationHtml = location ? `<dl class="detail-list">${detail('经纬度', `${location.lat}, ${location.lon}`)}${detail('采样时间', when(location.device_ts))}${detail('精度 / 来源', `${fmt(location.accuracy_m, ' m')} / ${location.source}`)}${detail('采样新鲜度', name(location.freshness))}</dl><p class="hint">这是事件关联的采样点，当前位置以概览的最新状态为准。</p>` : empty('这项事件没有关联位置。');
  const acknowledged = acknowledgement ? `<p class="hint">已于 ${esc(when(acknowledgement.acknowledged_at))} 确认知晓。${acknowledgement.note ? `<br>备注：${esc(acknowledgement.note)}` : ''}</p>` : `<p class="hint">尚未确认知晓。</p>${canWrite && event.status === 'open' ? button('我已知晓', 'ack', event.id) : ''}`;
  const notifications = event.notifications.map((notification) => `<div class="data-row"><div class="row-body"><div class="row-title">${esc(name(notification.status))} · ${notification.read_at ? '已读' : '未读'}</div><div class="row-note">创建于 ${esc(when(notification.created_at))}${notification.sent_at ? `<br>通道处理于 ${esc(when(notification.sent_at))}` : ''}${notification.read_at ? `<br>已读于 ${esc(when(notification.read_at))}` : ''}</div></div>${!notification.read_at ? button('标为已读', 'read', notification.id) : ''}</div>`).join('');
  return `<div class="record-type">${esc(name(event.type))} ${badge(event.status, event.status === 'open')}</div><dl class="detail-list">${detail('发生时间', when(event.occurred_at))}${detail('关闭时间', when(event.closed_at))}${detail('手机实际送达', '未知')}${facts}</dl>${evidence.message ? `<p class="hint">${esc(evidence.message)}</p>` : ''}<h3>关联位置</h3>${locationHtml}<h3>家庭处置记录</h3>${acknowledged}<p class="hint">确认知晓只记录家庭处置，不关闭事件。</p><h3>我的通知</h3>${notifications ? `<div class="rows">${notifications}</div>` : empty('当前账号没有这项事件的通知。')}<p class="hint">仅展示当前账号的通知。离线模拟或服务商受理不等于手机实际送达；已读与事件确认独立记录。</p>`;
}
