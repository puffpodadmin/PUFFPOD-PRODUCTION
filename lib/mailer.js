const nodemailer = require('nodemailer');
const path = require('path');
const STORE_EMAIL = 'support.puffpod@gmail.com';
const ASSETS_DIR = path.join(__dirname, '..', 'assets', 'email');

function money(v){ return new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format(Number(v)||0); }
function firstName(name){ return String(name||'cliente').trim().split(/\s+/)[0] || 'cliente'; }
function pixLabel(t){
  return { cpf:'CPF', cnpj:'CNPJ', email:'E-mail', phone:'Telefone', random:'Chave aleatória' }[String(t||'').toLowerCase()] || String(t||'');
}

let cachedTransporter = null;
function getTransporter(){
  if(cachedTransporter) return cachedTransporter;
  const appPassword = process.env.PUFFPOD_GMAIL_APP_PASSWORD;
  if(!appPassword) throw new Error('PUFFPOD_GMAIL_APP_PASSWORD não configurada na Vercel.');
  cachedTransporter = nodemailer.createTransport({ service:'gmail', auth:{ user:STORE_EMAIL, pass:appPassword } });
  return cachedTransporter;
}

// Banners ilustrados (panda Puffpod) usados no topo de cada e-mail. Os
// arquivos ficam em /assets/email e são anexados como inline (cid), então
// aparecem no corpo do e-mail em qualquer cliente, sem depender de imagem
// hospedada externamente.
const BANNERS = {
  orderPaid:          { file:'payment-confirmed.jpg',    cid:'banner-payment-confirmed@puffpod',    alt:'Pagamento confirmado' },
  withdrawRequested:  { file:'withdrawal-requested.jpg',  cid:'banner-withdrawal-requested@puffpod',  alt:'Solicitação de saque efetuada' },
  withdrawPaid:       { file:'withdrawal-approved.jpg',   cid:'banner-withdrawal-approved@puffpod',   alt:'Solicitação de saque aprovada' },
  withdrawRejected:   { file:'withdrawal-rejected.jpg',   cid:'banner-withdrawal-rejected@puffpod',   alt:'Solicitação de saque negada' },
};

function bannerAttachment(key){
  const b = BANNERS[key];
  if(!b) return null;
  return { filename:b.file, path:path.join(ASSETS_DIR,b.file), cid:b.cid };
}

function shell(bannerKey, bodyHtml){
  const b = BANNERS[bannerKey];
  const bannerImg = b ? `<img src="cid:${b.cid}" alt="${b.alt}" width="600" style="width:100%;max-width:600px;height:auto;display:block;border-radius:18px 18px 0 0" />` : '';
  return `<div style="font-family:Arial,sans-serif;background:#061d2c;padding:28px 14px;color:#eaf6fb">
    <div style="max-width:600px;margin:auto;background:#0b3550;border:1px solid #1d5573;border-radius:18px;overflow:hidden">
      ${bannerImg}
      <div style="padding:26px 28px 30px">${bodyHtml}</div>
    </div>
  </div>`;
}

async function sendMail({to, subject, html, text, attachments}){
  if(!to) throw new Error('Destinatário de e-mail ausente.');
  const transporter = getTransporter();
  await transporter.sendMail({ from:`Puffpod <${STORE_EMAIL}>`, to, replyTo:STORE_EMAIL, subject, text, html, attachments });
}

async function sendPaymentConfirmedEmail({ to, name, orderId, amount }){
  const fn = firstName(name);
  const subject = `Pagamento confirmado — Pedido ${orderId}`;
  const text = `Olá, ${fn}!\n\nSeu pagamento foi confirmado com sucesso.\n\nPedido: ${orderId}\nValor pago: ${money(amount)}\n\nSeu produto está a caminho.\n\nPuffpod`;
  const html = shell('orderPaid', `<p>Olá, <strong>${fn}</strong>!</p><p>Recebemos seu pagamento com sucesso. Seu pedido já está sendo preparado.</p><div style="background:#06283d;border-radius:12px;padding:16px;margin-top:10px"><div style="font-size:12px;letter-spacing:1px;color:#7fa8c9">CÓDIGO DO PEDIDO</div><div style="font-family:monospace;font-size:19px;color:#67e8f9">${orderId}</div><div style="margin-top:12px">Valor pago: <strong>${money(amount)}</strong></div></div>`);
  await sendMail({ to, subject, text, html, attachments:[bannerAttachment('orderPaid')] });
}

async function sendWithdrawalRequestedEmail({ to, name, amount, pixType, pixKey }){
  const fn = firstName(name);
  const subject = 'Sua solicitação de saque foi recebida — Puffpod';
  const text = `Olá, ${fn}!\n\nRecebemos sua solicitação de saque de ${money(amount)} via Pix (${pixLabel(pixType)}: ${pixKey}).\n\nEla está em análise e em breve estará disponível em sua conta corrente.\n\nPuffpod`;
  const html = shell('withdrawRequested', `<p>Olá, <strong>${fn}</strong>!</p><p>Recebemos sua solicitação e ela já está em análise. Assim que for processada, o valor estará disponível em sua conta corrente.</p><div style="background:#06283d;border-radius:12px;padding:16px;margin-top:10px"><div style="font-size:12px;letter-spacing:1px;color:#7fa8c9">VALOR SOLICITADO</div><div style="font-size:19px;color:#67e8f9">${money(amount)}</div><div style="margin-top:10px">Chave Pix (${pixLabel(pixType)}): <strong>${pixKey}</strong></div></div>`);
  await sendMail({ to, subject, text, html, attachments:[bannerAttachment('withdrawRequested')] });
}

async function sendWithdrawalPaidEmail({ to, name, amount, pixType, pixKey }){
  const fn = firstName(name);
  const subject = 'Saque aprovado — Puffpod';
  const text = `Olá, ${fn}!\n\nSeu saque de ${money(amount)} já foi realizado e o valor já consta em sua conta corrente.\n\nPuffpod`;
  const html = shell('withdrawPaid', `<p>Olá, <strong>${fn}</strong>!</p><p>Seu saque já foi processado e o valor já consta em sua conta corrente.</p><div style="background:#06283d;border-radius:12px;padding:16px;margin-top:10px"><div style="font-size:12px;letter-spacing:1px;color:#7fa8c9">VALOR PAGO</div><div style="font-size:19px;color:#67e8f9">${money(amount)}</div><div style="margin-top:10px">Chave Pix (${pixLabel(pixType)}): <strong>${pixKey}</strong></div></div>`);
  await sendMail({ to, subject, text, html, attachments:[bannerAttachment('withdrawPaid')] });
}

async function sendWithdrawalRejectedEmail({ to, name, amount, reason }){
  const fn = firstName(name);
  const subject = 'Sua solicitação de saque foi estornada — Puffpod';
  const reasonText = String(reason||'').trim() || 'Não informado.';
  const text = `Olá, ${fn}!\n\nSeu saque de ${money(amount)} foi estornado e o valor voltou para o seu saldo disponível.\n\nMotivo: ${reasonText}\n\nPuffpod`;
  const html = shell('withdrawRejected', `<p>Olá, <strong>${fn}</strong>!</p><p>Seu saque foi estornado e o valor de <strong>${money(amount)}</strong> voltou para o seu saldo disponível para uma nova solicitação.</p><div style="background:#06283d;border-radius:12px;padding:16px;margin-top:10px"><div style="font-size:12px;letter-spacing:1px;color:#7fa8c9">MOTIVO</div><div style="margin-top:6px">${reasonText}</div></div>`);
  await sendMail({ to, subject, text, html, attachments:[bannerAttachment('withdrawRejected')] });
}

module.exports = {
  sendMail, money, firstName, pixLabel,
  sendPaymentConfirmedEmail,
  sendWithdrawalRequestedEmail, sendWithdrawalPaidEmail, sendWithdrawalRejectedEmail
};
