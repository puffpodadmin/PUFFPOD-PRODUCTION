const https=require('https');

function postJson(urlString,payload,timeoutMs=20000){
  return new Promise((resolve,reject)=>{
    const url=new URL(urlString), body=Buffer.from(JSON.stringify(payload));
    const request=https.request({protocol:url.protocol,hostname:url.hostname,port:443,path:url.pathname+url.search,method:'POST',family:4,headers:{'Content-Type':'application/json','Accept':'application/json','Content-Length':body.length}},response=>{
      let raw=''; response.setEncoding('utf8'); response.on('data',c=>raw+=c); response.on('end',()=>{let data;try{data=raw?JSON.parse(raw):{};}catch{data={message:raw||'Resposta inválida da InfinitePay'};} resolve({ok:response.statusCode>=200&&response.statusCode<300,status:response.statusCode||0,data});});
    });
    request.setTimeout(timeoutMs,()=>request.destroy(new Error('Timeout ao conectar com a InfinitePay')));
    request.on('error',reject); request.write(body); request.end();
  });
}
function safe(err){return {message:String(err?.message||'Falha de rede').slice(0,240),code:err?.code||null};}

module.exports = async function handler(req,res){
  if(req.method!=='POST') return res.status(405).json({error:'Method not allowed'});
  const handle=String(process.env.INFINITEPAY_HANDLE||'').replace(/^\$/,'').trim();
  if(!handle) return res.status(500).json({error:'INFINITEPAY_HANDLE não configurada na Vercel.'});
  const {order_nsu,transaction_nsu,slug}=req.body||{};
  if(!order_nsu||!transaction_nsu||!slug) return res.status(400).json({error:'Dados da transação incompletos.'});
  const payload={handle,order_nsu:String(order_nsu),transaction_nsu:String(transaction_nsu),slug:String(slug)};
  const endpoints=['https://api.checkout.infinitepay.io/payment_check','https://api.infinitepay.io/invoices/public/checkout/payment_check'];
  const diagnostic=[];
  for(const endpoint of endpoints){
    try{
      const result=await postJson(endpoint,payload);
      diagnostic.push({endpoint,status:result.status});
      if(result.ok) return res.status(200).json(result.data);
      if(result.status>=400&&result.status<500) return res.status(result.status).json({error:result.data?.error||result.data?.message||'Não foi possível validar o pagamento.',provider_status:result.status,provider_details:result.data});
    }catch(err){diagnostic.push({endpoint,...safe(err)});}
  }
  console.error('InfinitePay payment_check connection failed',diagnostic);
  return res.status(502).json({error:'Não foi possível consultar a InfinitePay agora.',code:'INFINITEPAY_CONNECTION_FAILED',diagnostic});
};
