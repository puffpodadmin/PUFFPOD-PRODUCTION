module.exports = async function handler(req,res){
  if(req.method!=='POST') return res.status(405).json({error:'Method not allowed'});
  const handle=String(process.env.INFINITEPAY_HANDLE||'').replace(/^\$/,'').trim();
  if(!handle) return res.status(500).json({error:'INFINITEPAY_HANDLE não configurada na Vercel.'});
  try{
    const {order_nsu,transaction_nsu,slug}=req.body||{};
    if(!order_nsu||!transaction_nsu||!slug) return res.status(400).json({error:'Dados da transação incompletos.'});
    const upstream=await fetch('https://api.checkout.infinitepay.io/payment_check',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({handle,order_nsu:String(order_nsu),transaction_nsu:String(transaction_nsu),slug:String(slug)})
    });
    const raw=await upstream.text();
    let data; try{data=JSON.parse(raw);}catch{data={message:raw||'Resposta inválida da InfinitePay'};}
    return res.status(upstream.status).json(data);
  }catch(err){
    console.error('infinitepay-payment-check error',err);
    return res.status(500).json({error:'Falha ao consultar pagamento na InfinitePay.'});
  }
};
