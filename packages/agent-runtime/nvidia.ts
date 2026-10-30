import { nvidiaProvider as official } from '@earendil-works/pi-ai/providers/nvidia';
import { legacyNemotron } from './model.ts';
export function nvidiaProvider() { const base=official();return {...base,getModels:()=>{const models=base.getModels();return models.some(model=>model.id===legacyNemotron.id)?models:[...models,legacyNemotron];}};}
