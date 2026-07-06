// ============================================================
// 幻翔中台 — 後端 (hub-server.js)
// 管全部客戶部署：清單 CRUD、健康檢查（伺服器端 ping，免 CORS）、月費總覽
//
// 環境變數（Render → Environment）：
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY   幻翔內部 Supabase（跑過 hub_schema.sql 的那個）
//   APP_TOKEN                                  前端共享密碼
//   PORT                                       Render 自動給
// 啟動：npm i express cors @supabase/supabase-js && node hub-server.js
// ============================================================
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, APP_TOKEN, PORT = 3000 } = process.env;
const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

// 客戶前端模板（與本檔同資料夾，一起放進 repo）
let TEMPLATE = '';
try { TEMPLATE = fs.readFileSync(path.join(__dirname, 'client-frontend-template.html'), 'utf8'); }
catch (_) { console.warn('找不到 client-frontend-template.html，前端生成功能不可用'); }

// 把 hex 顏色加深，給 accent-d 用
function darken(hex, amt = 0.18) {
  const m = String(hex).replace('#', '').match(/^([0-9a-f]{6})$/i);
  if (!m) return hex;
  const p = [0, 2, 4].map(i => Math.round(parseInt(m[1].slice(i, i + 2), 16) * (1 - amt)));
  return '#' + p.map(v => Math.max(0, v).toString(16).padStart(2, '0')).join('');
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '512kb' }));

function requireToken(req, res, next) {
  if (!APP_TOKEN) return next();
  if (req.headers['x-app-token'] === APP_TOKEN) return next();
  return res.status(401).json({ error: '未授權' });
}

app.get('/health', (_, res) => res.json({ ok: true, service: 'xiang-hub' }));

// 清單（附月費總覽）
app.get('/deployments', requireToken, async (_, res) => {
  const { data, error } = await sb.from('hub_deployments').select('*').order('created_at', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  const rows = data || [];
  const mrr = rows.filter(d => d.status === 'active' || d.status === 'trial')
    .reduce((s, d) => s + (Number(d.monthly_fee) || 0), 0);
  res.json({ count: rows.length, mrr, deployments: rows });
});

// 新增
app.post('/deployments', requireToken, async (req, res) => {
  const b = req.body || {};
  if (!b.client_name || !b.product_line) return res.status(400).json({ error: 'client_name 與 product_line 必填' });
  const { data, error } = await sb.from('hub_deployments').insert({
    client_name: b.client_name, product_line: b.product_line, plan: b.plan || null,
    seats: b.seats ?? null, monthly_fee: b.monthly_fee ?? 0, setup_fee: b.setup_fee ?? 0,
    status: b.status || 'active', frontend_url: b.frontend_url || null, backend_url: b.backend_url || null,
    health_path: b.health_path || '/health', supabase_ref: b.supabase_ref || null,
    line_oa: b.line_oa || null, contact: b.contact || null, started_at: b.started_at || null, notes: b.notes || null,
  }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// 更新
app.patch('/deployments/:id', requireToken, async (req, res) => {
  const allow = ['client_name','product_line','plan','seats','monthly_fee','setup_fee','status',
    'frontend_url','backend_url','health_path','supabase_ref','line_oa','contact','started_at','notes'];
  const patch = { updated_at: new Date().toISOString() };
  for (const k of allow) if (req.body[k] !== undefined) patch[k] = req.body[k];
  const { data, error } = await sb.from('hub_deployments').update(patch).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// 刪除
app.delete('/deployments/:id', requireToken, async (req, res) => {
  const { error } = await sb.from('hub_deployments').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// 健康檢查：伺服器端逐一 ping 每個部署的 backend_url + health_path（前端呼叫這支，免 CORS 問題）
// 一鍵生成客戶前端：套模板 → 回傳客製好的 HTML（由前端觸發下載成 index.html，你自己拖去 Netlify 部署）
app.post('/generate-frontend', requireToken, async (req, res) => {
  try {
    if (!TEMPLATE) return res.status(500).json({ error: '伺服器缺少前端模板檔' });
    const b = req.body || {};
    if (!b.brand_name || !b.backend_url) return res.status(400).json({ error: 'brand_name 與 backend_url 必填' });
    const primary = /^#[0-9a-f]{6}$/i.test(b.primary || '') ? b.primary : '#0F5C8C';
    const cfgKey = 'cfg_' + String(b.brand_name).replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 20) + '_' + Math.random().toString(36).slice(2, 6);
    const html = TEMPLATE
      .split('__PRIMARY_D__').join(darken(primary))
      .split('__PRIMARY__').join(primary)
      .split('__BRAND_NAME__').join(b.brand_name)
      .split('__BRAND_SUB__').join(b.brand_sub || '安裝支援平台')
      .split('__BACKEND_URL__').join(String(b.backend_url).replace(/\/$/, ''))
      .split('__CFG_KEY__').join(cfgKey);
    res.json({ ok: true, html, filename: 'index.html', bytes: Buffer.byteLength(html, 'utf8') });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

app.get('/check-health', requireToken, async (_, res) => {
  const { data } = await sb.from('hub_deployments').select('id,backend_url,health_path').not('backend_url', 'is', null);
  const out = {};
  await Promise.all((data || []).map(async d => {
    const url = String(d.backend_url).replace(/\/$/, '') + (d.health_path || '/health');
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 8000);
      const r = await fetch(url, { signal: ctrl.signal });
      clearTimeout(t);
      out[d.id] = r.ok ? 'up' : 'error';
    } catch (_) { out[d.id] = 'down'; }
  }));
  res.json(out);   // { <id>: 'up'|'error'|'down' }  down 可能只是 Render 免費層在休眠
});

app.listen(PORT, () => console.log(`Xiang hub on :${PORT}`));
