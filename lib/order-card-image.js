const path = require('path');
const sharp = require('sharp');
const { createCanvas, GlobalFonts } = require('@napi-rs/canvas');

// As fontes do sistema não existem no ambiente da Vercel (lambda), então o
// texto desenhado via SVG (sharp/librsvg) saía como quadradinhos (glyph
// ausente). Por isso o texto agora é desenhado com @napi-rs/canvas, que usa
// a fonte embutida abaixo (não depende de nada instalado no servidor).
const FONT_BOLD_PATH = path.join(__dirname, '..', 'assets', 'fonts', 'JetBrainsMono-Bold.ttf');
const FONT_EXTRABOLD_PATH = path.join(__dirname, '..', 'assets', 'fonts', 'JetBrainsMono-ExtraBold.ttf');
const FONT_BOLD_FAMILY = 'Puffpod Mono Bold';
const FONT_EXTRABOLD_FAMILY = 'Puffpod Mono ExtraBold';
let fontsRegistered = false;
function ensureFonts(){
  if(fontsRegistered) return;
  GlobalFonts.registerFromPath(FONT_BOLD_PATH, FONT_BOLD_FAMILY);
  GlobalFonts.registerFromPath(FONT_EXTRABOLD_PATH, FONT_EXTRABOLD_FAMILY);
  fontsRegistered = true;
}

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

function drawLine(ctx, cfg, text, width, height){
  const family = cfg.fontWeight >= 800 ? FONT_EXTRABOLD_FAMILY : FONT_BOLD_FAMILY;
  ctx.font = `${cfg.fontWeight} ${cfg.fontSize}px "${family}"`;
  ctx.fillStyle = cfg.color;
  ctx.textAlign = cfg.anchor === 'middle' ? 'center' : (cfg.anchor === 'end' ? 'right' : 'left');
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(String(text == null ? '' : text), width * cfg.xPct / 100, height * cfg.yPct / 100);
}

// Função genérica: desenha line1/line2 em cima de qualquer template.
async function renderCardPng({ templatePath, line1, line2, layout }){
  ensureFonts();
  const resolvedTemplate = templatePath || TEMPLATES.paymentConfirmed;
  const base = sharp(resolvedTemplate);
  const meta = await base.metadata();
  const width = meta.width || 1200;
  const height = meta.height || 1200;

  const lay = layout || TEXT_LAYOUT;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  drawLine(ctx, lay.line1, line1, width, height);
  drawLine(ctx, lay.line2, line2, width, height);

  const buffer = await base
    .composite([{ input: canvas.toBuffer('image/png'), top: 0, left: 0 }])
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
