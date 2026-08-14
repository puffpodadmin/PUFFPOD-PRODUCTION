const {getAdmin}=require('../lib/firebase-admin');
module.exports=async function handler(req,res){
  if(req.method!=='POST')return res.status(405).json({error:'Method not allowed'});
  try{
    const h=String(req.headers.authorization||'');if(!h.startsWith('Bearer '))return res.status(401).json({error:'Sessão não encontrada.'});
    const admin=getAdmin(),decoded=await admin.auth().verifyIdToken(h.slice(7)),orderId=String(req.body?.orderId||'');
    const snap=await admin.firestore().collection('orders').doc(orderId).get();if(!snap.exists)return res.status(404).json({error:'Pedido não encontrado.'});
    const d=snap.data()||{};if(String(d.uid||'')!==decoded.uid)return res.status(403).json({error:'Pedido não pertence à sua sessão.'});
    return res.status(200).json({orderId,status:d.status||'pending_payment',paymentStatus:d.paymentStatus||'pending',paid:d.paymentStatus==='paid',transactionId:d.mgxpay?.transactionId||null,confirmationEmailSent:!!d.confirmationEmailSent,confirmationWhatsappSent:!!d.confirmationWhatsappSent});
  }catch(err){console.error('mgxpay-order-status',err);return res.status(400).json({error:err.message||'Falha ao consultar pedido.'});}
};
