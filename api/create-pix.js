const { quoteDelivery } = require('../lib/delivery');

function decodeUidFromToken(token){
  try{
    const part=String(token||'').split('.')[1];
    if(!part) return null;
    const json=Buffer.from(part.replace(/-/g,'+').replace(/_/g,'/'),'base64').toString('utf8');
    return JSON.parse(json).sub || null;
  }catch(e){ return null; }
}
async function getCashbackBalanceCents(req){
  const h=String(req.headers.authorization||'');
  if(!h.startsWith('Bearer ')) return 0;
  const token=h.slice(7), uid=decodeUidFromToken(token);
  if(!uid) return 0;
  const url=`https://firestore.googleapis.com/v1/projects/puffpod-28a24/databases/(default)/documents/users/${encodeURIComponent(uid)}`;
  const r=await fetch(url,{headers:{Authorization:`Bearer ${token}`}});
  if(!r.ok) return 0;
  const doc=await r.json();
  const f=(doc.fields||{}).cashback||{};
  const value=Number(f.doubleValue ?? f.integerValue ?? 0);
  return Math.max(0,Math.round(value*100));
}
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const ci = process.env.PAYSURE_CI;
  const cs = process.env.PAYSURE_CS;
  if (!ci || !cs) return res.status(500).json({ error: 'Credenciais Paysure não configuradas na Vercel.' });
  try {
    const { orderId, subtotal_cents, cashback_cents, cep, name, document } = req.body || {};
    const subtotal = Number(subtotal_cents);
    const cashback = Math.max(0, Number(cashback_cents) || 0);
    if (!orderId || !Number.isInteger(subtotal) || subtotal < 100) return res.status(400).json({ error: 'Pedido ou subtotal inválido.' });
    const delivery = await quoteDelivery(cep, subtotal);
    const maxCashback = Math.max(0, subtotal + delivery.feeCents - 100);
    if(!Number.isInteger(cashback) || cashback > maxCashback) return res.status(400).json({error:'Valor de cashback inválido.'});
    if(cashback > 0){
      const availableCashback = await getCashbackBalanceCents(req);
      if(cashback > availableCashback) return res.status(403).json({error:'Saldo de cashback insuficiente ou sessão expirada.'});
    }
    const cents = subtotal + delivery.feeCents - cashback;
    if(cents < 100) return res.status(400).json({error:'O total mínimo para pagamento é R$ 1,00.'});

    const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0];
    const host = (req.headers['x-forwarded-host'] || req.headers.host || 'puffpod.com.br').split(',')[0];
    const postbackUrl = `${proto}://${host}/api/paysure-webhook`;
    const upstream = await fetch('https://api.paysurebr.com/v1/pix/qrcode', {
      method: 'POST',
      headers: { 'ci': ci, 'cs': cs, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        external_id: String(orderId).slice(0, 191), value_cents: cents, postbackUrl,
        generator_name: String(name || '').slice(0, 191) || null,
        generator_document: String(document || '').replace(/\D/g, '').slice(0, 32) || null,
        description: `Pedido Puffpod ${String(orderId).slice(0, 100)}`, expiration_seconds: 3600
      })
    });
    const raw = await upstream.text();
    let data; try { data = JSON.parse(raw); } catch { data = { message: raw || 'Resposta inválida da Paysure' }; }
    if (!upstream.ok) return res.status(upstream.status).json(data);
    return res.status(201).json({...data, calculated:{subtotal_cents:subtotal,delivery_fee_cents:delivery.feeCents,cashback_cents:cashback,total_cents:cents,delivery}});
  } catch (err) {
    console.error('create-pix error', err);
    return res.status(err.status || 500).json({ error: err.message || 'Falha interna ao gerar o PIX.' });
  }
};
