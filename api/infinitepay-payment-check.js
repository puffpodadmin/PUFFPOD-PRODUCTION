module.exports = async function handler(req,res){
  if(req.method!=='POST') return res.status(405).json({error:'Method not allowed'});
  const handle=String(process.env.INFINITEPAY_HANDLE||'').replace(/^\$/,'').trim();
  if(!handle) return res.status(500).json({error:'INFINITEPAY_HANDLE não configurada na Vercel.'});
  const {order_nsu,transaction_nsu,slug}=req.body||{};
  if(!order_nsu||!transaction_nsu||!slug) return res.status(400).json({error:'Dados da transação incompletos.'});
  const payload={handle,order_nsu:String(order_nsu),transaction_nsu:String(transaction_nsu),slug:String(slug)};
  const endpoints=['https://api.checkout.infinitepay.io/payment_check','https://api.infinitepay.io/invoices/public/checkout/payment_check'];
  let last=null;
  for(const endpoint of endpoints){
    const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),12000);
    try{
      const r=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json','User-Agent':'Puffpod/1.0'},body:JSON.stringify(payload),signal:controller.signal});
      const raw=await r.text();let data;try{data=JSON.parse(raw);}catch{data={message:raw||'Resposta inválida da InfinitePay'};}
      if(r.ok) return res.status(200).json(data);
      if(r.status>=400&&r.status<500&&r.status!==404&&r.status!==405) return res.status(r.status).json({error:data.error||data.message||'Não foi possível validar o pagamento.',details:data});
      last=new Error(data.error||data.message||('HTTP '+r.status));
    }catch(err){last=err;}finally{clearTimeout(timeout);}
  }
  console.error('InfinitePay payment_check connection failed',last);
  return res.status(502).json({error:'Não foi possível consultar a InfinitePay agora. Tente novamente em alguns instantes.',code:'INFINITEPAY_CONNECTION_FAILED'});
};
