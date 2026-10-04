const path = require('path');
const sharp = require('sharp');

// Gera uma imagem com duas linhas de texto dinâmico (ex: código do pedido +
// valor pago) sobrepostas numa arte de fundo (templatePath), pra ser usada
// como a imagem principal de e-mails de notificação (pagamento confirmado,
// saque solicitado/aprovado/negado, etc).
//
// Como funciona: carrega a arte de fundo (PNG/JPG, criada pelo lojista),
// desenha um SVG transparente do mesmo tamanho só com o texto dinâmico nas
// posições configuradas em TEXT_LAYOUT, e "cola" esse SVG em cima da arte
// com o sharp. O resultado é uma única imagem PNG.
//
// Caixa reservada nas artes (coordenadas enviadas pelo lojista, base
// 1080x1350): X:60 Y:1040 Largura:960 Altura:250 — ou seja, de 77,0% a
// 95,6% da altura e centralizada horizontalmente. As posições abaixo são em
// % da imagem, então funcionam em qualquer resolução que mantenha essa
// mesma proporção. Todas as artes (pagamento confirmado, saque efetuado,
// saque aprovado, saque negado) usam essa mesma caixa, então o mesmo layout
// serve para todas.
const TEXT_LAYOUT = {
  // Linha 1 (ex: código do pedido "PP-MUT5H7ML-EDII", ou referência do saque)
  line1: { xPct: 50, yPct: 82.2, fontSize: 36, color: '#67e8f9', fontWeight: 700, anchor: 'middle' },
  // Linha 2 (ex: valor "R$ 88,88")
  line2: { xPct: 50, yPct: 88.9, fontSize: 46, color: '#ffffff', fontWeight: 800, anchor: 'middle' }
};

const TEMPLATES = {
  paymentConfirmed: path.join(__dirname, '..', 'assets', 'email', 'pagamento-confirmado-template.png'),
  withdrawalRequested: path.join(__dirname, '..', 'assets', 'email', 'saque-efetuado-template.png'),
  withdrawalPaid: path.join(__dirname, '..', 'assets', 'email', 'saque-aprovado-template.png'),
  withdrawalRejected: path.join(__dirname, '..', 'assets', 'email', 'saque-negado-template.png')
};

function escXml(s){
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Função genérica: desenha line1/line2 em cima de qualquer template.
async function renderCardPng({ templatePath, line1, line2, layout }){
  const resolvedTemplate = templatePath || TEMPLATES.paymentConfirmed;
  const base = sharp(resolvedTemplate);
  const meta = await base.metadata();
  const width = meta.width || 1200;
  const height = meta.height || 1200;

  const lay = layout || TEXT_LAYOUT;
  const l1 = lay.line1, l2 = lay.line2;
  const svg = `
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <style>
        .t { font-family: 'JetBrains Mono', 'Courier New', monospace; }
      </style>
      <text x="${width * l1.xPct / 100}" y="${height * l1.yPct / 100}" class="t"
            font-size="${l1.fontSize}" font-weight="${l1.fontWeight}" fill="${l1.color}"
            text-anchor="${l1.anchor}">${escXml(line1)}</text>
      <text x="${width * l2.xPct / 100}" y="${height * l2.yPct / 100}" class="t"
            font-size="${l2.fontSize}" font-weight="${l2.fontWeight}" fill="${l2.color}"
            text-anchor="${l2.anchor}">${escXml(line2)}</text>
    </svg>`;

  const buffer = await base
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .png()
    .toBuffer();

  return buffer;
}

// Mantido por compatibilidade com api/order-confirmation.js (já entregue e
// em uso) — chama renderCardPng com os nomes antigos dos campos.
async function renderOrderCardPng({ orderId, amountText, templatePath }){
  return renderCardPng({
    templatePath: templatePath || TEMPLATES.paymentConfirmed,
    line1: orderId,
    line2: amountText
  });
}

module.exports = { renderCardPng, renderOrderCardPng, TEXT_LAYOUT, TEMPLATES };
