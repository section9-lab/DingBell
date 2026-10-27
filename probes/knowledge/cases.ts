import type { KnowledgeDraft, KnowledgeScope } from '../../src/shared/knowledge.ts';

// Fictional facts for a retrieval benchmark. These are not Ozon policies or merchant data.
export const datasetVersion='dingbell-semantic-ru-zh-v2';
export type EvaluationDocument={id:string;language:'ru'|'zh-CN';scope:KnowledgeScope;draft:KnowledgeDraft};
export type EvaluationCase={id:string;split:'calibration'|'holdout';queryLanguage:'ru'|'zh-CN';knowledgeLanguage:'ru'|'zh-CN';
  question:string;expectedDocumentId:string|null;referenceFact:string|null;difficulty:'standard'|'hard_negative'|'long_document'|'cross_language'};
const uuid=(number:number)=>`00000000-0000-4000-8000-${String(number).padStart(12,'0')}`;
const longRu=Array.from({length:18},(_,index)=>`Раздел ${index+1}. Перед обслуживанием учебного увлажнителя M8 отключите питание и используйте только чистую салфетку. Не добавляйте неподтверждённые жидкости.`).join('\n')+'\nСброс M8: при отключённом питании удерживайте кнопку режима пять секунд, затем снова подключите питание. Код E8 означает, что резервуар установлен неплотно.';
const longZh=Array.from({length:18},(_,index)=>`第 ${index+1} 节：维护示例 M8 加湿器前应断开电源，并且只使用干净软布。不要加入资料未确认的液体。`).join('\n')+'\nM8 重置方法：断电时按住模式按钮五秒，然后重新接通电源。E8 代码表示水箱安装不牢。';
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
  ['OR26X — органайзер','Модель OR26X: ширина 27 см, глубина 19 см, высота 13 см. Цвет — чёрный. Это не модель OR26.',
    'OR26X 桌面收纳盒','OR26X 型号：宽度 27 厘米，深度 19 厘米，高度 13 厘米，颜色为黑色。它不是 OR26 型号。','guide','OR26X'],
  ['L5 Pro — питание','Лампа L5 Pro включается двойным нажатием. Для питания используйте только USB 9 В, 2 А. Инструкция обычной L5 к L5 Pro не применяется.',
    'L5 Pro 电源说明','L5 Pro 台灯双击开机，只能使用 USB 9 伏、2 安电源。普通 L5 的说明不适用于 L5 Pro。','guide','L5-PRO'],
  ['M8 — полное руководство',longRu,'M8 完整说明',longZh,'guide','M8'],
  ['Возврат неиспользованного товара','В учебном магазине неиспользованный товар можно подать на проверку в течение 14 календарных дней после получения. Проверка обязательна; автоматический возврат денег не обещается.',
    '示例店铺未使用商品退货','示例店铺允许在收货后 14 个自然日内提交未使用商品审核。必须经过审核，不承诺自动退款。','policy',null],
];
export const evaluationDocuments:EvaluationDocument[]=(['ru','zh-CN'] as const).flatMap((language,lang)=>source.map((row,index)=>({
  id:uuid(lang*source.length+index+1),language,scope:{kind:row[4],storeId:'synthetic-semantic-store',productRef:row[5],language},
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
  ['Какова ширина именно OR26X?','OR26X 的宽度是多少？','27 см','27 厘米',6,'calibration'],
  ['OR26X белый, как OR26?','OR26X 和 OR26 一样是白色吗？','Нет, OR26X чёрный','不是，OR26X 是黑色',6,'holdout'],
  ['Какой блок питания нужен для L5 Pro?','L5 Pro 需要什么电源？','USB 9 В, 2 А','USB 9 伏、2 安',7,'calibration'],
  ['Обычная L5 включается двойным нажатием?','普通 L5 是双击开机吗？','Нет, кнопку нужно удерживать две секунды','不是，需要按住按钮两秒',2,'holdout'],
  ['Как сбросить увлажнитель M8?','如何重置 M8 加湿器？','При отключённом питании удерживать кнопку режима пять секунд','断电时按住模式按钮五秒',8,'holdout'],
  ['Сколько дней даётся для подачи неиспользованного товара на проверку?','未使用商品可在多少天内提交审核？','14 календарных дней','14 个自然日',9,'calibration'],
  ['Сколько OR26X сейчас есть на складе?','OR26X 当前库存是多少？','', '',null,'holdout'],
  ['Одобрена ли моя персональная гарантия на M8?','我的 M8 个人保修申请批准了吗？','', '',null,'calibration'],
];
export const evaluationCases:EvaluationCase[]=(['ru','zh-CN'] as const).flatMap((language,lang)=>[
  ...questions.map((row,index)=>({id:`${language}-${index+1}`,split:row[5],queryLanguage:language,knowledgeLanguage:language,
    question:lang?row[1]:row[0],expectedDocumentId:row[4]===null?null:uuid(lang*source.length+row[4]+1),referenceFact:row[4]===null?null:lang?row[3]:row[2],
    difficulty:row[4]===null?'hard_negative' as const:row[4]===8?'long_document' as const:'standard' as const})),
  {id:`${language}-cross-depth`,split:'calibration' as const,queryLanguage:language,knowledgeLanguage:lang?'ru' as const:'zh-CN' as const,
    question:lang?'OR26 的深度是多少？':'Какая глубина у модели OR26?',expectedDocumentId:uuid((1-lang)*source.length+1),referenceFact:lang?'18 厘米':'18 см',difficulty:'cross_language' as const},
  {id:`${language}-cross-length`,split:'holdout' as const,queryLanguage:language,knowledgeLanguage:lang?'ru' as const:'zh-CN' as const,
    question:lang?'C60 充电线有多长？':'Какова длина зарядного кабеля C60?',expectedDocumentId:uuid((1-lang)*source.length+4),referenceFact:lang?'60 厘米':'60 см',difficulty:'cross_language' as const},
]);
