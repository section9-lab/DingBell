// Synthetic imported snapshots; no seller credentials or live customer data.
export function conversationContextSQL(organizationId:string,storeId:string,orderNumber='order-1',sku='9007199254740993') {
  const q=(value:unknown)=>`'${String(value).replaceAll("'","''")}'`;
  const scope=`${q(organizationId)},${q(storeId)}`;
  const product=JSON.stringify({id:'901',offerId:'DESK-BOX',name:'桌面收纳盒',sku:'11',sources:[{sku,source:'fbs'}],price:'1099.00',currency:'RUB',archived:false,primaryImage:'https://ir-20.ozone.ru/s3/context-product.jpg',images:['https://ir-20.ozone.ru/s3/context-product.jpg'],private_note:'DO_NOT_EXPOSE'});
  const statements=[`INSERT INTO product (id,organization_id,store_id,listing,list_observed_at,facts,facts_observed_at,detail_epoch,detail_generation,detail_due_at) VALUES ('901',${scope},'{"id":"901","offerId":"DESK-BOX","sku":null}',500,${q(product)},600,1,1,1)`];
  for(let index=1;index<=12;index++) {
    const postingNumber=`${orderNumber}-${String(index).padStart(2,'0')}`;
    const facts={postingNumber,orderId:'801',orderNumber,status:'awaiting_deliver',products:[{sku,offerId:'DESK-BOX',name:'桌面收纳盒',quantity:1,price:'1099.00',currency:'RUB'}],trackingNumber:'TRACK-SYNTHETIC',inProcessAt:null,shipmentDate:null,deliveringDate:null,address:'DO_NOT_EXPOSE'};
    statements.push(`INSERT INTO fbs_posting (posting_number,organization_id,store_id,order_id,order_number,list_facts,list_observed_at,detail_facts,detail_observed_at,detail_epoch,detail_generation,detail_due_at) VALUES (${q(postingNumber)},${scope},'801',${q(orderNumber)},${q(JSON.stringify({...facts,status:'delivering'}))},800,${q(JSON.stringify(facts))},700,1,1,1)`);
  }
  return statements;
}
