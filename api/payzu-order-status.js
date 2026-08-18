const { getAdmin } = require('../lib/firebase-admin');
const { payzuFetch } = require('../lib/payzu');
const { processPaidOrder } = require('../lib/payzu-orders');

module.exports=async function handler(req,res){
  if(req.method!=='POST') return res.status(405).json({error:'Method not allowed'});
  try{
    const auth=String(req.headers.authorization||'');
    if(!auth.startsWith('Bearer ')) return res.status(401).json({error:'Sessão do pedido não encontrada.'});
    const admin=getAdmin(),decoded=await admin.auth().verifyIdToken(auth.slice(7)),db=admin.firestore();
    const orderId=String((req.body||{}).orderId||'');
    if(!orderId) return res.status(400).json({error:'Pedido não informado.'});

    let snap=await db.collection('orders').doc(orderId).get();
    if(!snap.exists) return res.status(404).json({error:'Pedido não encontrado.'});
    let order=snap.data()||{};
    if(order.uid&&order.uid!==decoded.uid) return res.status(403).json({error:'Pedido não pertence a esta sessão.'});

    if(order.paymentStatus!=='paid'){
      const txId=order.payzu&&order.payzu.transactionId;
      if(txId){
        try{
          const p=await payzuFetch(`/pix?id=${encodeURIComponent(txId)}`,{tokenType:'deposit'});
          await db.collection('orders').doc(orderId).set({
            payzu:{
              ...(order.payzu||{}),
              status:String(p.status||''),
              lastCheckedAt:admin.firestore.FieldValue.serverTimestamp()
            }
          },{merge:true});
          if(String(p.status||'').toUpperCase()==='COMPLETED'){
            await processPaidOrder(db,admin,orderId,p);
          }
        }catch(e){
          console.warn('PayZu status fallback',e.message,e.requestId||'');
        }
      }
      snap=await db.collection('orders').doc(orderId).get();
      order=snap.data()||{};
    }

    return res.status(200).json({
      ok:true,
      orderId,
      status:order.status||'',
      paymentStatus:order.paymentStatus||'',
      paid:order.paymentStatus==='paid',
      transactionId:order.payzu&&order.payzu.transactionId||null,
      payzuStatus:order.payzu&&order.payzu.status||null
    });
  }catch(err){
    console.error('payzu-order-status',err);
    return res.status(400).json({error:err.message||'Falha ao consultar pagamento.'});
  }
};
