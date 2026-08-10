module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).json({ ok: true });
  try {
    const event = req.body || {};
    const cashin = event.cashin;
    if (cashin) {
      console.log('Paysure cash-in webhook', {
        reference_code: cashin.reference_code,
        external_reference: cashin.external_reference,
        status: cashin.status,
        value_cents: cashin.value_cents,
        payment_date: cashin.payment_date
      });
    }
    // Nesta primeira versão o checkout consulta o status via backend.
    // O próximo endurecimento é gravar o webhook diretamente no Firestore com Firebase Admin.
  } catch (err) {
    console.error('paysure-webhook error', err);
  }
  // A Paysure orienta responder 200 inclusive para eventos desconhecidos para evitar retries desnecessários.
  return res.status(200).json({ ok: true });
};
