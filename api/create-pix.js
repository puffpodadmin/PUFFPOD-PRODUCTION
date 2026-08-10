module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ci = process.env.PAYSURE_CI;
  const cs = process.env.PAYSURE_CS;
  if (!ci || !cs) return res.status(500).json({ error: 'Credenciais Paysure não configuradas na Vercel.' });

  try {
    const { orderId, value_cents, name, document } = req.body || {};
    const cents = Number(value_cents);
    if (!orderId || !Number.isInteger(cents) || cents < 100) {
      return res.status(400).json({ error: 'Pedido ou valor inválido.' });
    }

    const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0];
    const host = (req.headers['x-forwarded-host'] || req.headers.host || 'puffpod.com.br').split(',')[0];
    const postbackUrl = `${proto}://${host}/api/paysure-webhook`;

    const upstream = await fetch('https://api.paysurebr.com/v1/pix/qrcode', {
      method: 'POST',
      headers: {
        'ci': ci,
        'cs': cs,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        external_id: String(orderId).slice(0, 191),
        value_cents: cents,
        postbackUrl,
        generator_name: String(name || '').slice(0, 191) || null,
        generator_document: String(document || '').replace(/\D/g, '').slice(0, 32) || null,
        description: `Pedido Puffpod ${String(orderId).slice(0, 100)}`,
        expiration_seconds: 3600
      })
    });

    const raw = await upstream.text();
    let data;
    try { data = JSON.parse(raw); } catch { data = { message: raw || 'Resposta inválida da Paysure' }; }
    if (!upstream.ok) return res.status(upstream.status).json(data);
    return res.status(201).json(data);
  } catch (err) {
    console.error('create-pix error', err);
    return res.status(500).json({ error: 'Falha interna ao gerar o PIX.' });
  }
};
