const { renderCardPng, TEMPLATES, TEXT_LAYOUT } = require('./order-card-image');
const { sendBrandedEmail } = require('./mailer');

function money(v){ return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(v) || 0); }
function firstNameOf(name){ return String(name || 'cliente').trim().split(/\s+/)[0] || 'cliente'; }
function refCode(withdrawalId){ return 'SQ-' + String(withdrawalId || '').slice(0, 8).toUpperCase(); }

async function renderWithdrawalCard(templatePath, withdrawalId, amount){
  try{
    return await renderCardPng({
      templatePath,
      line1: refCode(withdrawalId),
      line2: money(amount),
      layout: TEXT_LAYOUT
    });
  }catch(e){
    console.warn('withdrawal card image', e.message);
    return null;
  }
}

// Disparado assim que o usuário solicita o saque (status inicial "processing"/"pending").
async function sendWithdrawalRequestedEmail({ to, name, amount, withdrawalId }){
  const firstName = firstNameOf(name);
  const cardImage = await renderWithdrawalCard(TEMPLATES.withdrawalRequested, withdrawalId, amount);
  await sendBrandedEmail({
    to,
    subject: 'Solicitação de saque recebida — Puffpod',
    text: `Olá, ${firstName}!\n\nRecebemos sua solicitação de saque no valor de ${money(amount)}.\n\nReferência: ${refCode(withdrawalId)}\n\nEla está em análise e você será avisado assim que for processada.\n\nPuffpod`,
    cardImage,
    imageFilename: 'puffpod-saque-solicitado.png',
    fallbackHtml: `<div style="background:#06283d;border-radius:12px;padding:16px"><div>REFERÊNCIA</div><div style="font-family:monospace;font-size:19px;color:#67e8f9">${refCode(withdrawalId)}</div><div style="margin-top:12px">Valor: <strong>${money(amount)}</strong></div></div>`
  });
}

// Disparado quando o admin clica em "Marcar como pago" no painel.
async function sendWithdrawalPaidEmail({ to, name, amount, withdrawalId }){
  const firstName = firstNameOf(name);
  const cardImage = await renderWithdrawalCard(TEMPLATES.withdrawalPaid, withdrawalId, amount);
  await sendBrandedEmail({
    to,
    subject: 'Saque aprovado — Puffpod',
    text: `Olá, ${firstName}!\n\nSeu saque de ${money(amount)} foi aprovado e o valor já foi enviado via Pix.\n\nReferência: ${refCode(withdrawalId)}\n\nPuffpod`,
    cardImage,
    imageFilename: 'puffpod-saque-aprovado.png',
    fallbackHtml: `<div style="background:#06283d;border-radius:12px;padding:16px"><div>REFERÊNCIA</div><div style="font-family:monospace;font-size:19px;color:#67e8f9">${refCode(withdrawalId)}</div><div style="margin-top:12px">Valor: <strong>${money(amount)}</strong></div></div>`
  });
}

// Disparado quando o admin clica em "Rejeitar e devolver saldo" no painel.
async function sendWithdrawalRejectedEmail({ to, name, amount, withdrawalId, reason }){
  const safeReason = String(reason || '').replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]));
  const firstName = firstNameOf(name);
  const cardImage = await renderWithdrawalCard(TEMPLATES.withdrawalRejected, withdrawalId, amount);
  await sendBrandedEmail({
    to,
    subject: 'Saque não aprovado — Puffpod',
    text: `Olá, ${firstName}!\n\nSua solicitação de saque de ${money(amount)} não pôde ser processada e o valor foi devolvido ao seu saldo disponível para novo saque.\n\n${reason ? 'Motivo: ' + reason + '\n\n' : ''}Referência: ${refCode(withdrawalId)}\n\nPuffpod`,
    afterHtml: reason ? `<div style="margin-top:16px;background:#06283d;border:1px solid #1d5573;border-radius:12px;padding:14px 16px;color:#eaf6fb;font-size:14px;line-height:1.5"><div style="font-size:12px;letter-spacing:.08em;color:#67e8f9;margin-bottom:6px">MOTIVO DO ESTORNO</div>${safeReason}</div>` : '',
    cardImage,
    imageFilename: 'puffpod-saque-negado.png',
    fallbackHtml: `<div style="background:#06283d;border-radius:12px;padding:16px"><div>REFERÊNCIA</div><div style="font-family:monospace;font-size:19px;color:#67e8f9">${refCode(withdrawalId)}</div><div style="margin-top:12px">Valor: <strong>${money(amount)}</strong></div></div>`
  });
}

module.exports = { sendWithdrawalRequestedEmail, sendWithdrawalPaidEmail, sendWithdrawalRejectedEmail };
