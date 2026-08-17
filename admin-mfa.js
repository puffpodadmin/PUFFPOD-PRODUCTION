const { quoteDelivery } = require('../lib/delivery');
module.exports = async function handler(req,res){
  if(req.method !== 'POST') return res.status(405).json({error:'Method not allowed'});
  try{
    const {cep, subtotal_cents, address} = req.body || {};
    const quote = await quoteDelivery(cep, subtotal_cents, address);
    res.setHeader('Cache-Control','no-store');
    return res.status(200).json({
      ...quote,
      base_fee_cents: quote.baseFeeCents,
      surcharge_cents: quote.surchargeCents,
      fee_cents: quote.feeCents,
      free_shipping: quote.freeShipping,
      surcharge_active: quote.surchargeActive
    });
  }catch(err){
    console.error('delivery-quote',err);
    return res.status(err.status || 500).json({error:err.message || 'Não foi possível calcular a entrega.'});
  }
};
