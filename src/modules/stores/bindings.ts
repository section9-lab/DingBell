import type { CredentialBindings } from './credentials.ts';

export type StoreBindings = CredentialBindings;
export interface StoreDependencies { storeFetch?: typeof fetch }
