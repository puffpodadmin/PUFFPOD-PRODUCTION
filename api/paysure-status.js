module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ci = process.env.PAYSURE_CI;
  const cs = process.env.PAYSURE_CS;
  if (!ci || !cs) return res.status(500).json({ error: 'Credenciais Paysure não configuradas.' });

  try {
    const { reference_code, external_reference } = req.body || {};
    if (!reference_code && !external_reference) {
      return res.status(400).json({ error: 'Informe reference_code ou external_reference.' });
    }
    const payload = {};
    if (reference_code) payload.reference_code = String(reference_code);
    if (external_reference) payload.external_reference = String(external_reference);

    const upstream = await fetch('https://api.paysurebr.com/v1/pix/cashin/consult', {
      method: 'POST',
      headers: { 'ci': ci, 'cs': cs, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const raw = await upstream.text();
    let data;
    try { data = JSON.parse(raw); } catch { data = { message: raw || 'Resposta inválida da Paysure' }; }
    return res.status(upstream.status).json(data);
  } catch (err) {
    console.error('paysure-status error', err);
    return res.status(500).json({ error: 'Falha ao consultar pagamento.' });
  }
};
