import type { KnowledgeDraft, KnowledgeScope } from '../../src/shared/knowledge.ts';

// Fictional facts for a retrieval benchmark. These are not Ozon policies or merchant data.
export const datasetVersion='dingbell-semantic-ru-zh-v1';
export type EvaluationDocument={id:string;language:'ru'|'zh-CN';scope:KnowledgeScope;draft:KnowledgeDraft};
export type EvaluationCase={id:string;split:'calibration'|'holdout';queryLanguage:'ru'|'zh-CN';knowledgeLanguage:'ru'|'zh-CN';
  question:string;expectedDocumentId:string|null;referenceFact:string|null};
const uuid=(number:number)=>`00000000-0000-4000-8000-${String(number).padStart(12,'0')}`;
const source: [string,string,string,string,KnowledgeScope['kind'],string|null][]=[
  ['OR26 — настольный органайзер','Модель OR26: ширина 26 см, глубина 18 см, высота 12 см. Цвет — белый.',
    'OR26 桌面收纳盒','OR26 型号：宽度 26 厘米，深度 18 厘米，高度 12 厘米。颜色为白色。','guide','OR26'],
  ['OR36 — настольный органайзер','Модель OR36: ширина 36 см, глубина 24 см, высота 16 см. Цвет — серый.',
    'OR36 桌面收纳盒','OR36 型号：宽度 36 厘米，深度 24 厘米，高度 16 厘米。颜色为灰色。','guide','OR36'],
  ['L5 — включение лампы','Для включения лампы L5 удерживайте кнопку питания две секунды. Для зарядки используйте источник питания USB 5 В, 1 А.',
    'L5 台灯使用说明','开启 L5 台灯时，按住电源按钮两秒。充电时使用 USB 5 伏、1 安的电源。','guide','L5'],
  ['C60 — кабель для зарядки','Кабель C60 имеет разъёмы USB-C с обеих сторон. Длина — 60 см. Он предназначен только для зарядки и не поддерживает передачу данных.',
    'C60 充电线说明','C60 线缆的两端都是 USB-C，长度为 60 厘米。仅用于充电，不支持数据传输。','guide','C60'],
  ['Условия доставки в учебном магазине','Стоимость доставки показывается при оформлении заказа и зависит от условий, указанных на этой странице. В учебном магазине нет общего обещания бесплатной доставки для всех заказов.',
    '示例店铺配送说明','配送费用在提交订单前的结算页面展示，以该页面列出的条件为准。示例店铺没有所有订单均包邮的统一承诺。','policy',null],
  ['Повреждённый товар: порядок обращения','Если товар повреждён, подготовьте номер заказа и фотографии повреждения для обращения в поддержку магазина. Обращение требует проверки; автоматическое одобрение возврата денег не обещается.',
    '示例店铺破损商品处理流程','发现商品破损时，准备订单号和破损照片，联系店铺客服核实。申请需要审核，不承诺自动批准退款。','policy',null],
];
export const evaluationDocuments:EvaluationDocument[]=(['ru','zh-CN'] as const).flatMap((language,lang)=>source.map((row,index)=>({
  id:uuid(lang*6+index+1),language,scope:{kind:row[4],storeId:'synthetic-semantic-store',productRef:row[5],language},
  draft:{title:lang?row[2]:row[0],source:{format:'text' as const,content:lang?row[3]:row[1]}},
})));
// The reference fact is for the evaluator/reviewer only; it is never joined to an embedding query.
const questions: [string,string,string,string,number|null,'calibration'|'holdout'][]=[
  ['Какая ширина органайзера OR26?','OR26 收纳盒有多宽？','26 см','26 厘米',0,'calibration'],
  ['Сколько сантиметров в ширину у OR36?','OR36 型号的宽度是多少厘米？','36 см','36 厘米',1,'calibration'],
  ['Как включить лампу L5?','L5 台灯怎么开机？','Удерживать кнопку две секунды','按住电源按钮两秒',2,'calibration'],
  ['Какие разъёмы у кабеля C60 с двух сторон?','C60 线缆两端分别是什么接口？','USB-C с обеих сторон','两端都是 USB-C',3,'calibration'],
  ['Доставка в этом магазине всегда бесплатная?','这家店所有订单都包邮吗？','Нет общего обещания; условия видны при оформлении','没有统一包邮承诺，以结算页面为准',4,'calibration'],
  ['Что нужно подготовить, если товар пришёл повреждённым?','商品收到时破损了，需要准备什么？','Номер заказа и фотографии повреждения','订单号和破损照片',5,'calibration'],
  ['Когда именно приедет мой заказ с лампой L5?','我的 L5 台灯订单具体哪天送到？','', '',null,'calibration'],
  ['Одобрена ли мне персональная скидка 20% на OR26?','我买 OR26 的专属八折优惠批准了吗？','', '',null,'calibration'],
  ['В каком цвете указан органайзер модели OR26?','资料中 OR26 收纳盒是什么颜色？','Белый','白色',0,'holdout'],
  ['Какова высота модели OR36, не её ширина?','OR36 的高度是多少？我问的不是宽度。','16 см','16 厘米',1,'holdout'],
  ['Какое питание нужно для зарядки лампы L5?','给 L5 台灯充电需要多少伏、多少安的电源？','USB 5 В, 1 А','USB 5 伏、1 安',2,'holdout'],
  ['Можно ли передавать файлы через провод C60?','C60 线能传文件吗？','Нет, только зарядка','不能，只能充电',3,'holdout'],
  ['Где до покупки проверить, сколько стоит доставка?','购买前在哪里看配送费？','На странице оформления заказа','提交订单前的结算页面',4,'holdout'],
  ['Если я отправлю фото повреждения, возврат денег одобрят автоматически?','交了破损照片就一定自动退款吗？','Нет, обращение требует проверки','不会自动承诺，需要审核',5,'holdout'],
  ['Сколько серых OR36 осталось в наличии прямо сейчас?','灰色 OR36 现在还剩多少库存？','', '',null,'holdout'],
  ['Заказ 12345 с кабелем C60 уже прибыл в пункт выдачи?','装着 C60 的订单 12345 到取件点了吗？','', '',null,'holdout'],
];
export const evaluationCases:EvaluationCase[]=(['ru','zh-CN'] as const).flatMap((language,lang)=>[
  ...questions.map((row,index)=>({id:`${language}-${index+1}`,split:row[5],queryLanguage:language,knowledgeLanguage:language,
    question:lang?row[1]:row[0],expectedDocumentId:row[4]===null?null:uuid(lang*6+row[4]+1),referenceFact:row[4]===null?null:lang?row[3]:row[2]})),
  {id:`${language}-cross-depth`,split:'calibration' as const,queryLanguage:language,knowledgeLanguage:lang?'ru' as const:'zh-CN' as const,
    question:lang?'OR26 的深度是多少？':'Какая глубина у модели OR26?',expectedDocumentId:uuid((1-lang)*6+1),referenceFact:lang?'18 厘米':'18 см'},
  {id:`${language}-cross-length`,split:'holdout' as const,queryLanguage:language,knowledgeLanguage:lang?'ru' as const:'zh-CN' as const,
    question:lang?'C60 充电线有多长？':'Какова длина зарядного кабеля C60?',expectedDocumentId:uuid((1-lang)*6+4),referenceFact:lang?'60 厘米':'60 см'},
]);
