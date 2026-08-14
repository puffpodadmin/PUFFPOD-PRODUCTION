const { getAdmin } = require('../lib/firebase-admin');
module.exports=async function handler(req,res){
  if(req.method!=='POST') return res.status(405).json({error:'Method not allowed'});
  try{
    const auth=String(req.headers.authorization||'');
    if(!auth.startsWith('Bearer ')) return res.status(401).json({error:'Sessão do pedido não encontrada.'});
    const admin=getAdmin(); const decoded=await admin.auth().verifyIdToken(auth.slice(7));
    const orderId=String((req.body||{}).orderId||'');
    const snap=await admin.firestore().collection('orders').doc(orderId).get();
    if(!snap.exists) return res.status(404).json({error:'Pedido não encontrado.'});
    const o=snap.data()||{};
    if(o.uid && o.uid!==decoded.uid) return res.status(403).json({error:'Pedido não pertence a esta sessão.'});
    return res.status(200).json({ok:true,orderId,status:o.status||'',paymentStatus:o.paymentStatus||'',paid:o.paymentStatus==='paid',transactionId:o.mgxpay&&o.mgxpay.transactionId||null});
  }catch(err){console.error('mgxpay-order-status',err);return res.status(400).json({error:err.message||'Falha ao consultar pedido.'});}
};
