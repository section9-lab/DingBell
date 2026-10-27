import { Hono } from 'hono';
import { apiError, type ApplicationEnv } from './http.ts';
import { identityConfig } from './modules/identity/config.ts';
import { registerIdentityRoutes } from './modules/identity/http.ts';
import { registerBootstrapRoutes } from './modules/bootstrap/http.ts';
import { registerVerificationRoutes } from './modules/identity/verification-http.ts';
import { registerInvitationRoutes } from './modules/invitations/http.ts';
import { registerCompanySettingsRoutes } from './modules/company-settings/http.ts';
import { registerReplyPolicyRoutes } from './modules/reply-policies/http.ts';
import { registerKnowledgeRoutes } from './modules/knowledge/http.ts';
import { registerMembershipRoutes } from './modules/membership/http.ts';
import { registerStoreRoutes } from './modules/stores/http.ts';
import { registerSyncRoutes } from './modules/sync/http.ts';
import { registerConversationRoutes } from './modules/conversations/http.ts';
import { registerConversationControlRoutes } from './modules/conversations/control-http.ts';
import { registerTranslationRoutes } from './modules/translations/http.ts';
import { AuditUnavailable, OperationUnconfirmed } from './modules/audit/operation.ts';
import { mailConfigured } from './modules/mail/config.ts';
import type { IdentityDependencies } from './modules/mail/types.ts';
import type { StoreDependencies } from './modules/stores/bindings.ts';
import type { TranslationServiceDeps } from './modules/translations/api-types.ts';
import { registerReplyTestRoutes,type ReplyTestHttpDependencies } from './modules/reply-tests/http.ts';
import { registerReplyTestBudgetRoutes } from './modules/reply-tests/budget-http.ts';
import { registerAiBudgetRoutes } from './modules/ai-runs/budget-http.ts';
import { registerAiReceptionRoutes } from './modules/conversations/ai-http.ts';
import { registerAiDraftRoutes } from './modules/ai-runs/draft-http.ts';
import { registerBudgetAuditRoutes } from './modules/budget-audit/http.ts';
import {registerExportRoutes} from './modules/exports/http.ts';
import {registerAnalyticsRoutes} from './modules/analytics/http.ts';
import {registerDataGovernanceRoutes} from './modules/data-governance/http.ts';
import {registerDegradationRoutes} from './modules/degradation/http.ts';
import {registerCommerceRoutes} from './modules/commerce/http.ts';

export function createApp(deps: IdentityDependencies & StoreDependencies & TranslationServiceDeps & ReplyTestHttpDependencies = {}) {
  const app = new Hono<ApplicationEnv>();
  app.use('*', async (c, next) => {
    c.set('requestId', crypto.randomUUID());
    c.header('X-Request-ID', c.get('requestId'));
    c.header('Cache-Control', 'no-store');
    await next();
  });
  app.get('/api/health', c => c.json({ service: 'dingbell', status: 'ok' }));
  app.get('/api/setup', c => c.json({
    identity: { configured: !!identityConfig(c.env ?? {}) },
    registration: { enabled: false },
    email: { configured: mailConfigured(c.env ?? {}, deps) },
  }));
  registerIdentityRoutes(app, c => ({
    identity: { configured: !!identityConfig(c.env ?? {}) },
    registration: { enabled: false },
    email: { configured: mailConfigured(c.env ?? {}, deps) },
  }));
  registerBootstrapRoutes(app, deps);
  registerVerificationRoutes(app, deps);
  registerInvitationRoutes(app, deps);
  registerMembershipRoutes(app);
  registerCompanySettingsRoutes(app);
  registerReplyPolicyRoutes(app);
  registerKnowledgeRoutes(app);
  registerStoreRoutes(app, deps);
  registerSyncRoutes(app);
  registerCommerceRoutes(app);
  registerConversationRoutes(app);
  registerConversationControlRoutes(app);
  registerTranslationRoutes(app, deps);
  registerReplyTestRoutes(app, deps);
  registerReplyTestBudgetRoutes(app);
  registerAiBudgetRoutes(app);
  registerBudgetAuditRoutes(app);
  registerExportRoutes(app);
  registerAnalyticsRoutes(app);
  registerDataGovernanceRoutes(app);
  registerDegradationRoutes(app);
  registerAiReceptionRoutes(app);
  registerAiDraftRoutes(app);
  app.notFound(c => apiError(c, 'NOT_FOUND', 'The resource is not available.', 404));
  app.onError((error, c) => {
    if (error instanceof AuditUnavailable) return apiError(c, 'AUDIT_UNAVAILABLE', 'Audit storage is temporarily unavailable.', 503);
    if (error instanceof OperationUnconfirmed) return apiError(c, 'OPERATION_UNCONFIRMED', 'Refresh the session to confirm the operation state.', 503);
    return apiError(c, 'IDENTITY_UNAVAILABLE', 'The service is temporarily unavailable.', 503);
  });
  return app;
}
