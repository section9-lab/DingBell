import { DurableObject } from 'cloudflare:workers';
import { createStoreCoordinator } from './coordinator-core.ts';
export const StoreCoordinator = createStoreCoordinator(DurableObject);
export type StoreCoordinator = InstanceType<typeof StoreCoordinator>;
