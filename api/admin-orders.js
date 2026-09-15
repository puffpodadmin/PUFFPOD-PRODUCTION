const { getAdmin } = require('../lib/firebase-admin');
const { payzuFetch } = require('../lib/payzu');
const { processPaidOrder } = require('../lib/payzu-orders');
const ADMIN_EMAIL='support.puffpod@gmail.com';

module.exports=async function handler(req,res){
  if(req.method!=='POST') return res.status(405).json({error:'Method not allowed'});
  try{
    const h=String(req.headers.authorization||''); if(!h.startsWith('Bearer ')) return res.status(401).json({error:'Não autorizado.'});
    const admin=getAdmin(); const decoded=await admin.auth().verifyIdToken(h.slice(7));
    if(String(decoded.email||'').toLowerCase()!==ADMIN_EMAIL) return res.status(403).json({error:'Acesso restrito ao administrador.'});
    const db=admin.firestore();
    const body=req.body||{};
    const action=body.action;
    const orderId=String(body.orderId||'');
    if(!orderId) return res.status(400).json({error:'Pedido não informado.'});

    const orderRef=db.collection('orders').doc(orderId);
    const snap=await orderRef.get();
    if(!snap.exists) return res.status(404).json({error:'Pedido não encontrado.'});
    const order=snap.data()||{};

    if(order.paymentStatus==='paid'){
      return res.status(200).json({ok:true,alreadyPaid:true});
    }

    // Reconsulta o status real na PayZu (mesma verificação usada pelo cliente)
    // e processa a confirmação (cashback, comissão, e-mail liberado) se já
    // estiver COMPLETED. Útil para pedidos que ficaram presos por qualquer
    // instabilidade no webhook.
    if(action==='verify'){
      const txId=order.payzu&&order.payzu.transactionId;
      if(!txId) return res.status(400).json({error:'Pedido sem transação PayZu associada.'});
      const p=await payzuFetch(`/pix?id=${encodeURIComponent(txId)}`,{tokenType:'deposit'});
      await orderRef.set({
        payzu:{...(order.payzu||{}),status:String(p.status||''),lastCheckedAt:admin.firestore.FieldValue.serverTimestamp()}
      },{merge:true});
      if(String(p.status||'').toUpperCase()==='COMPLETED'){
        await processPaidOrder(db,admin,orderId,p);
        return res.status(200).json({ok:true,paid:true});
      }
      return res.status(200).json({ok:true,paid:false,payzuStatus:p.status||null});
    }

    // Confirmação manual: usada quando o pagamento foi validado por outro
    // meio (ex.: extrato bancário) e a PayZu não retorna mais o status.
    if(action==='markPaid'){
      await processPaidOrder(db,admin,orderId,{
        id:`MANUAL-${decoded.uid}-${Date.now()}`,
        amount:Number(order.total||0),
        paidAt:new Date().toISOString(),
        manualBy:decoded.email
      });
      return res.status(200).json({ok:true,paid:true,manual:true});
    }

    return res.status(400).json({error:'Ação inválida.'});
  }catch(err){
    console.error('admin-orders',err);
    return res.status(err.status&&err.status<500?err.status:400).json({error:err.message||'Falha ao processar o pedido.'});
  }
};
