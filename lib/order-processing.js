const { getAdmin } = require('./firebase-admin');
const nodemailer = require('nodemailer');

const STORE_EMAIL='support.puffpod@gmail.com';

function normalizeBrazilPhone(phone){
  let digits=String(phone||'').replace(/\D/g,'');
  if(!digits) return '';
  if(digits.startsWith('55')) return digits;
  if(digits.length===10||digits.length===11) return '55'+digits;
  return digits;
}

function money(value){
  return new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format(Number(value)||0);
}

async function sendWhatsAppTemplate(order){
  const token=process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId=process.env.WHATSAPP_PHONE_NUMBER_ID;
  const templateName=process.env.WHATSAPP_TEMPLATE_NAME||'pedido_confirmado';
  const languageCode=process.env.WHATSAPP_TEMPLATE_LANGUAGE||'pt_BR';
  const graphVersion=process.env.WHATSAPP_GRAPH_VERSION||'v23.0';
  if(!token||!phoneNumberId) throw new Error('WhatsApp Cloud API ainda não configurada na Vercel.');
  const recipient=normalizeBrazilPhone(order.phone);
  if(!recipient) throw new Error('Pedido sem telefone válido para WhatsApp.');
  const firstName=String(order.name||'cliente').trim().split(/\s+/)[0]||'cliente';
  const components=[];
  const headerImageUrl=String(process.env.WHATSAPP_HEADER_IMAGE_URL||'').trim();
  if(headerImageUrl) components.push({type:'header',parameters:[{type:'image',image:{link:headerImageUrl}}]});
  components.push({type:'body',parameters:[{type:'text',text:firstName},{type:'text',text:String(order.orderId||'')}]});
  const r=await fetch(`https://graph.facebook.com/${graphVersion}/${encodeURIComponent(phoneNumberId)}/messages`,{
    method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
    body:JSON.stringify({messaging_product:'whatsapp',to:recipient,type:'template',template:{name:templateName,language:{code:languageCode},components}})
  });
  const raw=await r.text(); let data; try{data=JSON.parse(raw);}catch{data={raw};}
  if(!r.ok){const detail=data?.error?.message||data?.error?.error_user_msg;throw new Error(detail||`Falha ao enviar WhatsApp (${r.status}).`);}
  return data;
}

async function sendNotifications(orderId){
  const admin=getAdmin(),db=admin.firestore(),ref=db.collection('orders').doc(String(orderId));
  const snap=await ref.get(); if(!snap.exists) throw new Error('Pedido não encontrado.');
  const order={orderId:snap.id,...snap.data()};
  const warnings=[]; let emailSent=!!order.confirmationEmailSent, whatsappSent=!!order.confirmationWhatsappSent;
  const firstName=String(order.name||'cliente').trim().split(/\s+/)[0]||'cliente';
  if(!emailSent){
    try{
      const pass=process.env.PUFFPOD_GMAIL_APP_PASSWORD;
      if(!pass) throw new Error('PUFFPOD_GMAIL_APP_PASSWORD não configurada.');
      if(!order.email) throw new Error('Pedido sem e-mail.');
      const transporter=nodemailer.createTransport({service:'gmail',auth:{user:STORE_EMAIL,pass}});
      const subject=`Pagamento confirmado — Pedido ${order.orderId}`;
      const text=`Olá, ${firstName}!\n\nSeu pagamento foi confirmado com sucesso.\n\nPedido: ${order.orderId}\nValor pago: ${money(order.total)}\n\nSeu pedido já está sendo preparado.\n\nPuffpod`;
      const html=`<div style="font-family:Arial,sans-serif;background:#061d2c;padding:28px;color:#eaf6fb"><div style="max-width:560px;margin:auto;background:#0b3550;border:1px solid #1d5573;border-radius:18px;padding:28px"><div style="font-size:12px;letter-spacing:2px;color:#48cae4;text-transform:uppercase">Puffpod</div><h1 style="font-size:24px;margin:10px 0 16px">Pagamento confirmado ✓</h1><p>Olá, <strong>${firstName}</strong>!</p><p>Recebemos seu pagamento e seu pedido já está sendo preparado.</p><div style="background:#06283d;border-radius:12px;padding:16px;margin:20px 0"><div style="color:#9ec0d8;font-size:12px">CÓDIGO DO PEDIDO</div><div style="font-family:monospace;font-size:19px;color:#67e8f9;margin-top:6px">${order.orderId}</div><div style="margin-top:12px;color:#cde6ef">Valor pago: <strong>${money(order.total)}</strong></div></div></div></div>`;
      await transporter.sendMail({from:`Puffpod <${STORE_EMAIL}>`,to:order.email,replyTo:STORE_EMAIL,subject,text,html});
      emailSent=true; await ref.set({confirmationEmailSent:true,confirmationEmailSentAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true});
    }catch(e){console.error('confirmation email',e);warnings.push('E-mail: '+e.message);}
  }
  if(!whatsappSent){
    try{
      const result=await sendWhatsAppTemplate(order); const messageId=result?.messages?.[0]?.id||null;
      const fields={confirmationWhatsappSent:true,confirmationWhatsappSentAt:admin.firestore.FieldValue.serverTimestamp()}; if(messageId)fields.confirmationWhatsappMessageId=messageId;
      await ref.set(fields,{merge:true}); whatsappSent=true;
    }catch(e){console.error('confirmation whatsapp',e);warnings.push('WhatsApp: '+e.message);}
  }
  return {emailSent,whatsappSent,warnings};
}

async function processCashback(orderId){
  const admin=getAdmin(),db=admin.firestore(),orderRef=db.collection('orders').doc(String(orderId));
  let result={processed:false};
  await db.runTransaction(async tx=>{
    const os=await tx.get(orderRef); if(!os.exists) throw new Error('Pedido não encontrado.');
    const order=os.data()||{}; if(order.cashbackProcessed){result={processed:true,already:true};return;}
    if(order.isGuest||!order.uid){tx.set(orderRef,{cashbackProcessed:true,cashbackUsed:0,cashbackEarned:0},{merge:true});result={processed:true,guest:true};return;}
    const userRef=db.collection('users').doc(String(order.uid)); const us=await tx.get(userRef); if(!us.exists){tx.set(orderRef,{cashbackProcessed:true,cashbackUsed:0,cashbackEarned:0},{merge:true});return;}
    const u=us.data()||{},current=Math.max(0,Number(u.cashback||0));
    const requested=Math.max(0,Number(order.cashbackUsed||0)); const used=Math.min(requested,current);
    const earned=Math.round(Math.max(0,Number(order.subtotal||0)-used)*0.01*100)/100;
    tx.set(userRef,{cashback:Math.max(0,Math.round((current-used+earned)*100)/100)},{merge:true});
    tx.set(orderRef,{cashbackProcessed:true,cashbackUsed:used,cashbackEarned:earned},{merge:true}); result={processed:true,used,earned};
  });
  return result;
}

async function processReferralCommission(orderId){
  const admin=getAdmin(),db=admin.firestore(),orderRef=db.collection('orders').doc(String(orderId)); let result={credited:false};
  await db.runTransaction(async tx=>{
    const os=await tx.get(orderRef); if(!os.exists) throw new Error('Pedido não encontrado.');
    const order=os.data()||{}; if(order.referralCommissionProcessed){result={credited:false,already:true};return;}
    const ref=order.referral||{},referrerUid=String(ref.referrerUid||'');
    if(!referrerUid){tx.set(orderRef,{referralCommissionProcessed:true,referralCommissionAmount:0},{merge:true});return;}
    const userRef=db.collection('users').doc(referrerUid),us=await tx.get(userRef);
    if(!us.exists){tx.set(orderRef,{referralCommissionProcessed:true,referralCommissionAmount:0,referralCommissionStatus:'referrer_not_found'},{merge:true});return;}
    const u=us.data()||{},percent=Number(u.referralCommissionPercent||0);
    if(![10,15,20].includes(percent)){tx.set(orderRef,{referralCommissionStatus:'waiting_rate'},{merge:true});return;}
    const base=Number(order.subtotal||0),amount=Math.round(base*percent)/100;
    if(amount<=0){tx.set(orderRef,{referralCommissionProcessed:true,referralCommissionAmount:0,referralCommissionPercent:percent},{merge:true});return;}
    tx.set(userRef,{referralEarningsTotal:admin.firestore.FieldValue.increment(amount),referralAvailable:admin.firestore.FieldValue.increment(amount),referralSalesCount:admin.firestore.FieldValue.increment(1),referralLastEarningAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true});
    tx.set(orderRef,{referralCommissionProcessed:true,referralCommissionStatus:'credited',referralCommissionAmount:amount,referralCommissionPercent:percent,referralCommissionBase:base,referralCommissionCreditedAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true});
    result={credited:true,amount,percent,referrerUid};
  }); return result;
}

async function markPaidAndProcess(orderId,paymentMeta={}){
  const admin=getAdmin(),db=admin.firestore(),ref=db.collection('orders').doc(String(orderId));
  await db.runTransaction(async tx=>{
    const snap=await tx.get(ref); if(!snap.exists) throw new Error('Pedido não encontrado.');
    const order=snap.data()||{};
    if(order.paymentStatus==='paid') return;
    tx.set(ref,{status:'paid',paymentStatus:'paid',paidAt:admin.firestore.FieldValue.serverTimestamp(),paymentMethod:'mgxpay',mgxpay:{...(order.mgxpay||{}),...paymentMeta,paidAt:admin.firestore.FieldValue.serverTimestamp()}},{merge:true});
  });
  const out={};
  try{out.cashback=await processCashback(orderId);}catch(e){console.error('cashback processing',e);}
  try{out.referral=await processReferralCommission(orderId);}catch(e){console.error('referral processing',e);}
  try{out.notifications=await sendNotifications(orderId);}catch(e){console.error('notifications processing',e);out.notifications={warnings:[e.message]};}
  return out;
}

module.exports={markPaidAndProcess,sendNotifications,processCashback,processReferralCommission};
