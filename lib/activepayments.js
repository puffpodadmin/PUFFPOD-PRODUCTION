const crypto = require('crypto');

// Gateway PRIMÁRIO de Pix (ActivePayments). A PayZu fica como fallback.
// Docs: https://activepayments.com.br/docs/authentication
//   Authorization: ApiKey {public_key}:{secret}
// Variáveis de ambiente (Vercel):
//   ACTIVEPAYMENTS_PUBLIC_KEY   ActivePayments_pk_...
//   ACTIVEPAYMENTS_SECRET_KEY   ActivePayments_sk_...
//   ACTIVEPAYMENTS_WEBHOOK_SECRET (opcional) secret do webhook, p/ validar X-Webhook-Signature
//   ACTIVEPAYMENTS_BASE_URL (opcional) padrão https://api.activepayments.com.br/api/v1
//   ACTIVEPAYMENTS_DISABLED=true (opcional) desliga e usa só a PayZu
const DEFAULT_BASE_URL = 'https://api.activepayments.com.br/api/v1';

function baseUrl(){ return String(process.env.ACTIVEPAYMENTS_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/,''); }
function keys(){
  return {
    pk: String(process.env.ACTIVEPAYMENTS_PUBLIC_KEY || '').trim(),
    sk: String(process.env.ACTIVEPAYMENTS_SECRET_KEY || '').trim()
  };
}
function isConfigured(){
  if(String(process.env.ACTIVEPAYMENTS_DISABLED || '').toLowerCase() === 'true') return false;
  const { pk, sk } = keys();
  return !!(pk && sk);
}

async function apFetch(path, options = {}){
  const { pk, sk } = keys();
  if(!pk || !sk) throw new Error('ActivePayments não configurada (ACTIVEPAYMENTS_PUBLIC_KEY / ACTIVEPAYMENTS_SECRET_KEY).');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(options.timeoutMs || 7000));
  try{
    const res = await fetch(baseUrl() + path, {
      method: options.method || 'GET',
      headers: {
        'Authorization': `ApiKey ${pk}:${sk}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal
    });
    const raw = await res.text();
    let data = {};
    try{ data = raw ? JSON.parse(raw) : {}; }catch{ data = { message: raw }; }
    if(!res.ok || data.success === false){
      const msg = (data.error && (data.error.message || data.error)) || data.message || `ActivePayments retornou HTTP ${res.status}.`;
      const err = new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
      err.status = res.status;
      err.details = data;
      throw err;
    }
    return data;
  }catch(err){
    if(err && err.name === 'AbortError') throw new Error('Tempo esgotado ao conectar com a ActivePayments.');
    throw err;
  }finally{
    clearTimeout(timer);
  }
}

// Cria a cobrança Pix. `amount` em REAIS (ex.: 79.9).
async function createPixCharge({ amount, name, cpf, email, phone, reference, postbackUrl, expirationMinutes = 15, info }){
  const body = {
    amount: Number(Number(amount).toFixed(2)),
    customerName: String(name || 'Cliente Puffpod').slice(0, 100),
    customerCpf: String(cpf || '').replace(/\D/g, ''),
    expirationMinutes,
    externalReference: reference,
    additionalInfo: info ? String(info).slice(0, 140) : undefined,
    customerEmail: email || undefined,
    customerPhone: phone ? String(phone).replace(/\D/g, '') : undefined,
    postbackUrl: postbackUrl || undefined
  };
  Object.keys(body).forEach(k => body[k] === undefined && delete body[k]);
  const res = await apFetch('/charges', { method: 'POST', body });
  const d = res.data || res;
  const pix = d.pix || {};
  if(!d.chargeId || !pix.qrCode) throw new Error('A ActivePayments não retornou o QR Code da cobrança.');
  return {
    id: String(d.chargeId),
    externalId: d.externalId ? String(d.externalId) : '',
    status: String(d.status || 'PENDING'),
    amount: Number(d.amount || amount),
    qrCodeText: String(pix.qrCode),
    qrCodeBase64: pix.qrCodeBase64 ? String(pix.qrCodeBase64).replace(/^data:image\/\w+;base64,/, '') : '',
    expiresAt: pix.expiresAt || null
  };
}

async function getCharge(id){
  const res = await apFetch(`/charges/${encodeURIComponent(id)}`);
  const d = res.data || res;
  const status = String(d.status || '').toLowerCase();
  return {
    id: String(d.chargeId || id),
    status,
    paid: status === 'paid',
    amount: Number(d.amount || 0),
    paidAt: d.paidAt || null,
    raw: d
  };
}

// X-Webhook-Signature = HMAC-SHA256(rawBody, webhook_secret) em hex.
function verifySignature(rawBody, signature){
  const secret = String(process.env.ACTIVEPAYMENTS_WEBHOOK_SECRET || '').trim();
  if(!secret || !signature) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected), b = Buffer.from(String(signature).trim());
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { isConfigured, createPixCharge, getCharge, verifySignature };
