const { quoteDelivery } = require('../lib/delivery');
module.exports = async function handler(req,res){
  if(req.method !== 'POST') return res.status(405).json({error:'Method not allowed'});
  try{
    const {cep, subtotal_cents} = req.body || {};
    const quote = await quoteDelivery(cep, subtotal_cents);
    res.setHeader('Cache-Control','no-store');
    return res.status(200).json(quote);
  }catch(err){
    console.error('delivery-quote',err);
    return res.status(err.status || 500).json({error:err.message || 'Não foi possível calcular a entrega.'});
  }
};
