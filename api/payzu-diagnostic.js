const { getAdmin } = require('../lib/firebase-admin');
const { payzuFetch } = require('../lib/payzu');

module.exports=async function handler(req,res){
  if(req.method!=='POST') return res.status(405).json({error:'Method not allowed'});
  try{
    const auth=String(req.headers.authorization||'');
    if(!auth.startsWith('Bearer ')) return res.status(401).json({error:'Autenticação necessária.'});

    const admin=getAdmin();
    const decoded=await admin.auth().verifyIdToken(auth.slice(7));
    const email=String(decoded.email||'').toLowerCase();
    if(email!=='support.puffpod@gmail.com') return res.status(403).json({error:'Apenas o administrador pode executar o diagnóstico.'});

    const data=await payzuFetch('/user/balance',{tokenType:'deposit',timeoutMs:15000});
    return res.status(200).json({
      ok:true,
      depositTokenAuthenticated:true,
      message:'PAYZU_DEPOSIT_TOKEN autenticado com sucesso.',
      hasAvailableBalance:Number.isFinite(Number(data.balanceAvailable))
    });
  }catch(err){
    console.error('payzu-diagnostic',{
      message:err.message,
      requestId:err.requestId,
      errorCode:err.errorCode,
      status:err.status
    });
    return res.status(err.status&&err.status<500?err.status:502).json({
      ok:false,
      error:err.message||'Falha ao autenticar na PayZu.',
      requestId:err.requestId||null,
      errorCode:err.errorCode||null,
      payzuStatusCode:err.status||null
    });
  }
};
