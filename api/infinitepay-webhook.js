module.exports = async function handler(req,res){
  if(req.method!=='POST') return res.status(200).json({success:true,message:null});
  try{
    const event=req.body||{};
    if(!event.order_nsu){
      return res.status(400).json({success:false,message:'Pedido não encontrado'});
    }
    console.log('InfinitePay payment webhook',{
      invoice_slug:event.invoice_slug,
      amount:event.amount,
      paid_amount:event.paid_amount,
      installments:event.installments,
      capture_method:event.capture_method,
      transaction_nsu:event.transaction_nsu,
      order_nsu:event.order_nsu,
      receipt_url:event.receipt_url
    });
    // O checkout também valida o pagamento em /payment_check no retorno do cliente.
    // Esse webhook deixa a conciliação registrada e está pronto para endurecimento com Firebase Admin no servidor.
    return res.status(200).json({success:true,message:null});
  }catch(err){
    console.error('infinitepay-webhook error',err);
    return res.status(400).json({success:false,message:'Falha ao processar evento'});
  }
};
