const nodemailer = require('nodemailer');
const STORE_EMAIL = 'support.puffpod@gmail.com';

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

function shell(title, bodyHtml){
  return `<div style="font-family:Arial,sans-serif;background:#061d2c;padding:28px;color:#eaf6fb"><div style="max-width:560px;margin:auto;background:#0b3550;border:1px solid #1d5573;border-radius:18px;padding:28px"><div style="font-size:12px;letter-spacing:2px;color:#48cae4;text-transform:uppercase">Puffpod</div><h1 style="margin:8px 0 14px">${title}</h1>${bodyHtml}</div></div>`;
}

async function sendMail({to, subject, html, text}){
  if(!to) throw new Error('Destinatário de e-mail ausente.');
  const transporter = getTransporter();
  await transporter.sendMail({ from:`Puffpod <${STORE_EMAIL}>`, to, replyTo:STORE_EMAIL, subject, text, html });
}

async function sendWithdrawalRequestedEmail({ to, name, amount, pixType, pixKey }){
  const fn = firstName(name);
  const subject = 'Seu saque está em análise — Puffpod';
  const text = `Olá, ${fn}!\n\nRecebemos sua solicitação de saque de ${money(amount)} via Pix (${pixLabel(pixType)}: ${pixKey}).\n\nEle está em análise e em breve estará disponível em sua conta corrente.\n\nPuffpod`;
  const html = shell('Saque em análise 🕒', `<p>Olá, <strong>${fn}</strong>!</p><p>Recebemos sua solicitação de saque e ela já está em análise. Assim que for processado, o valor estará disponível em sua conta corrente.</p><div style="background:#06283d;border-radius:12px;padding:16px;margin-top:10px"><div>VALOR SOLICITADO</div><div style="font-size:19px;color:#67e8f9">${money(amount)}</div><div style="margin-top:10px">Chave Pix (${pixLabel(pixType)}): <strong>${pixKey}</strong></div></div>`);
  await sendMail({ to, subject, text, html });
}

async function sendWithdrawalPaidEmail({ to, name, amount, pixType, pixKey }){
  const fn = firstName(name);
  const subject = 'Saque realizado — Puffpod';
  const text = `Olá, ${fn}!\n\nSeu saque de ${money(amount)} já foi realizado e está na sua conta.\n\nPuffpod`;
  const html = shell('Saque realizado ✓', `<p>Olá, <strong>${fn}</strong>!</p><p>Seu saque já foi processado e o valor já está na sua conta.</p><div style="background:#06283d;border-radius:12px;padding:16px;margin-top:10px"><div>VALOR PAGO</div><div style="font-size:19px;color:#67e8f9">${money(amount)}</div><div style="margin-top:10px">Chave Pix (${pixLabel(pixType)}): <strong>${pixKey}</strong></div></div>`);
  await sendMail({ to, subject, text, html });
}

async function sendWithdrawalRejectedEmail({ to, name, amount, reason }){
  const fn = firstName(name);
  const subject = 'Atualização sobre seu saque — Puffpod';
  const reasonText = String(reason||'').trim() || 'Não informado.';
  const text = `Olá, ${fn}!\n\nSeu saque de ${money(amount)} foi estornado e o valor voltou para o seu saldo disponível.\n\nMotivo: ${reasonText}\n\nPuffpod`;
  const html = shell('Saque estornado', `<p>Olá, <strong>${fn}</strong>!</p><p>Seu saque foi estornado e o valor de <strong>${money(amount)}</strong> voltou para o seu saldo disponível para um novo saque.</p><div style="background:#06283d;border-radius:12px;padding:16px;margin-top:10px"><div>MOTIVO</div><div style="margin-top:6px">${reasonText}</div></div>`);
  await sendMail({ to, subject, text, html });
}

module.exports = { sendMail, sendWithdrawalRequestedEmail, sendWithdrawalPaidEmail, sendWithdrawalRejectedEmail, money, firstName, pixLabel };
