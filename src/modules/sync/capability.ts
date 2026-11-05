export type SyncSourceKind = 'chat' | 'products' | 'fbs_postings' | 'fbo_postings' | 'fbp_postings';

/** The read capability each synchronization stream depends on. */
export function syncReadCapability(source: SyncSourceKind) {
  return source === 'chat' ? 'chats_read' : source === 'products' ? 'products_read' : source === 'fbs_postings' ? 'orders_fbs_read' : source==='fbo_postings'?'orders_fbo_read':'orders_fbp_read';
}

export interface SyncCapabilityView {
  hasCredentials: boolean;
  status: string;
  capabilities: readonly { code: string; status: string }[];
}

/**
 * Enabling a stream requires saved credentials, a current verification and the
 * matching read capability. Stopping never requires any of them.
 */
export function canEnableSync(view: SyncCapabilityView, source: SyncSourceKind) {
  const capability = syncReadCapability(source);
  return view.hasCredentials && ['verified', 'partial'].includes(view.status)
    && ['auth', capability].every(code => view.capabilities.some(item => item.code === code && item.status === 'available'));
}

export function syncCapabilityErrorCode(source: SyncSourceKind) {
  return source === 'chat' ? 'SYNC_CAPABILITY_REQUIRED' : source === 'products' ? 'PRODUCT_SYNC_CAPABILITY_REQUIRED'
    : source === 'fbs_postings' ? 'FBS_SYNC_CAPABILITY_REQUIRED' : source==='fbo_postings'?'FBO_SYNC_CAPABILITY_REQUIRED':'FBP_SYNC_CAPABILITY_REQUIRED';
}
