'use agent';
import { useModel, setProvider } from '@flue/runtime';
import { fauxProvider, fauxAssistantMessage, fauxText } from '@earendil-works/pi-ai';
const faux = fauxProvider({ api:'schema8-cloud-fixture', provider:'schema8-cloud-fixture', models:[{id:'reply'}] });
faux.setResponses([() => { return fauxAssistantMessage(fauxText('authentic schema8 cloud fixture reply')); }]);
setProvider(faux.provider);
export function HistoricalProbe() { useModel('schema8-cloud-fixture/reply'); return 'Return the deterministic test fixture response.'; }
HistoricalProbe.agentName = 'HistoricalProbe';
