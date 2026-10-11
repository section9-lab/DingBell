'use agent';
import { useModel, setProvider } from '@flue/runtime';
import { fauxProvider, fauxAssistantMessage, fauxText } from '@earendil-works/pi-ai';
const faux = fauxProvider({ api:'schema8-cloud-fixture', provider:'schema8-cloud-fixture', models:[{id:'reply'}] });
faux.setResponses([() => { throw new Error('The upgrade reader must not regenerate the original result.'); }]);
setProvider(faux.provider);
export function HistoricalProbe() { useModel('schema8-cloud-fixture/reply'); return 'Return the deterministic test fixture response.'; }
HistoricalProbe.agentName = 'HistoricalProbe';
