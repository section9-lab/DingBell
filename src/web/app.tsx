import {
  Activity,
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  onlineManager,
  QueryClient,
  QueryClientProvider,
  useQuery,
} from '@tanstack/react-query';
import { Navigate, Route, Routes, useLocation } from 'react-router';
import { ApiError, activateCompany, readIdentity, signOut, type Company } from './lib/api';
import { isWorkspacePath, workspaceRoutes, workspaceSection, type WorkspaceSection } from './lib/routes';
import {
  AuthFrame,
  ErrorNotice,
  LoadingPage,
  WorkspaceLoadingPage,
} from './components/identity-shared';
import { CompanySettingsProvider } from './components/company-settings-provider';
import { ToastProvider } from './components/ui/toast';
import { Button } from './components/ui/button';
import { LoginPage } from './pages/login';
import { invitationReturnTo } from './lib/account-links';
import { clearPendingReplies } from './lib/conversation-reply-pending';
import { clearPendingPreviews } from './lib/conversation-preview-pending';
import { clearAiResumptions } from './lib/ai-reception-pending';
import { clearReplyDrafts } from './lib/conversation-draft';

const loadBootstrap = () => import('./pages/bootstrap');
const loadAccountEmail = () => import('./pages/account-email');
const loadTeam = () => import('./pages/team');
const loadStores = () => import('./pages/stores');
const loadCompanySettings = () => import('./pages/company-settings');
const loadKnowledge = () => import('./pages/knowledge');
const loadCapabilities = () => import('./pages/capabilities');
const loadReplyPolicies = () => import('./pages/reply-policies');
const loadMessages = () => import('./pages/messages');
const loadProducts = () => import('./pages/products');
const loadOrders = () => import('./pages/orders');
const loadAccounting = () => import('./pages/accounting');
const loadActivity = () => import('./pages/activity');
const loadInvitation = () => import('./pages/invitation');
const loadWorkspace = () => import('./pages/workspace');
const BootstrapPage = lazy(async () => ({ default: (await loadBootstrap()).BootstrapPage }));
const AccountEmailPage = lazy(async () => ({ default: (await loadAccountEmail()).AccountEmailPage }));
const ConfirmAccountPage = lazy(async () => ({ default: (await loadAccountEmail()).ConfirmAccountPage }));
const TeamPage = lazy(async () => ({ default: (await loadTeam()).TeamPage }));
const StoresPage = lazy(async () => ({ default: (await loadStores()).StoresPage }));
const CompanySettingsPage = lazy(async () => ({ default: (await loadCompanySettings()).CompanySettingsPage }));
const KnowledgePage = lazy(async () => ({ default: (await loadKnowledge()).KnowledgePage }));
const CapabilitiesPage = lazy(async () => ({ default: (await loadCapabilities()).CapabilitiesPage }));
const ReplyPoliciesPage = lazy(async () => ({ default: (await loadReplyPolicies()).ReplyPoliciesPage }));
const MessagesPage = lazy(async () => ({ default: (await loadMessages()).MessagesPage }));
const ProductsPage = lazy(async () => ({ default: (await loadProducts()).ProductsPage }));
const OrdersPage = lazy(async () => ({ default: (await loadOrders()).OrdersPage }));
const AccountingPage = lazy(async () => ({ default: (await loadAccounting()).AccountingPage }));
const ActivityPage = lazy(async () => ({ default: (await loadActivity()).ActivityPage }));
const InvitationPage = lazy(async () => ({ default: (await loadInvitation()).InvitationPage }));
const CompanySelection = lazy(async () => ({ default: (await loadWorkspace()).CompanySelection }));
const WorkspacePage = lazy(async () => ({ default: (await loadWorkspace()).WorkspacePage }));
const workspaceLoaders: Record<string, () => Promise<unknown>> = {
  [workspaceRoutes.team]: loadTeam,
  [workspaceRoutes.stores]: loadStores,
  [workspaceRoutes.settings]: loadCompanySettings,
  [workspaceRoutes.knowledge]: loadKnowledge,
  [workspaceRoutes.capabilities]: loadCapabilities,
  [workspaceRoutes.policies]: loadReplyPolicies,
  [workspaceRoutes.messages]: loadMessages,
  [workspaceRoutes.products]: loadProducts,
  [workspaceRoutes.orders]: loadOrders,
  [workspaceRoutes.accounting]: loadAccounting,
  [workspaceRoutes.activity]: loadActivity,
};
function preloadWorkspaceRoute(pathname: string) {
  return Promise.allSettled([loadWorkspace(), workspaceLoaders[pathname]?.() ?? Promise.resolve()]);
}
const subscribeOnline = (listener: () => void) =>
  onlineManager.subscribe(listener);

function createClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: 0,
        refetchOnWindowFocus: 'always',
        refetchOnReconnect: 'always',
      },
      mutations: { retry: false },
    },
  });
}

export function App() {
  const location = useLocation();
  const workspaceRoute = isWorkspacePath(location.pathname);
  useEffect(() => { if (workspaceRoute) void preloadWorkspaceRoute(location.pathname); }, [workspaceRoute, location.pathname]);
  const [boundary, setBoundary] = useState(() => ({
    client: createClient(),
    version: 0,
    notice: undefined as unknown,
  }));
  async function reset(notice?: unknown) {
    await boundary.client.cancelQueries();
    boundary.client.clear();
    setBoundary((previous) => ({
      client: createClient(),
      version: previous.version + 1,
      notice,
    }));
  }
  return (
    <QueryClientProvider client={boundary.client}>
      <ToastProvider>
        <Suspense fallback={workspaceRoute ? <WorkspaceLoadingPage /> : <LoadingPage />}>
          <Routes>
            <Route path="/setup" element={<BootstrapPage reset={reset} />} />
            <Route path="/verify-email" element={<ConfirmAccountPage key="verify" kind="verification" />} />
            <Route path="/reset-password" element={<ConfirmAccountPage key="reset" kind="password" />} />
            <Route path="/forgot-password" element={<AccountEmailPage key="forgot" kind="password" />} />
            <Route path="/resend-verification" element={<AccountEmailPage key="resend" kind="verification" />} />
            <Route path="*" element={<IdentityPages key={boundary.version} reset={reset} notice={boundary.notice} />} />
          </Routes>
        </Suspense>
      </ToastProvider>
    </QueryClientProvider>
  );
}

function IdentityPages({
  reset,
  notice,
}: {
  reset: (notice?: unknown) => Promise<void>;
  notice?: unknown;
}) {
  const location = useLocation();
  const workspaceRoute = isWorkspacePath(location.pathname);
  const online = useSyncExternalStore(subscribeOnline, () =>
    onlineManager.isOnline(),
  );
  const wasOffline = useRef(!online);
  useEffect(() => {
    if (!online) wasOffline.current = true;
    else if (wasOffline.current) void reset(notice);
  }, [online, reset, notice]);
  const identity = useQuery({
    queryKey: ['identity'],
    queryFn: ({ signal }) => readIdentity(signal),
  });
  const [changing, setChanging] = useState(false);
  const busy = useRef(false);
  async function change(operation: () => Promise<unknown>) {
    if (busy.current) return;
    busy.current = true;
    setChanging(true);
    let error: unknown;
    try {
      await operation();
    } catch (cause) {
      error =
        cause instanceof ApiError
          ? cause
          : new ApiError('OPERATION_UNCONFIRMED');
    }
    // Never retain company-scoped caches or mounted drafts across an identity change.
    await reset(error);
  }
  function logout() {
    const userId = identity.data?.session?.user.id;
    void change(async () => {
      await signOut();
      if (userId) { try { clearPendingReplies(window.sessionStorage, { userId }); clearPendingPreviews(window.sessionStorage, { userId }); clearAiResumptions(window.sessionStorage, { userId }); clearReplyDrafts(window.sessionStorage, { userId }); } catch { /* Storage may be unavailable. */ } }
    });
  }
  if (!online || identity.isPaused)
    return (
      <AuthFrame>
        <div className="flex flex-col gap-3" role="alert">
          <h1 className="text-2xl font-semibold">网络已断开</h1>
          <p className="text-sm leading-6 text-muted-foreground">
            暂时无法确认账号与公司权限。恢复联网后会重新检查，再打开工作区。
          </p>
        </div>
      </AuthFrame>
    );
  if (changing || wasOffline.current)
    return workspaceRoute ? <WorkspaceLoadingPage message="正在确认账号状态…" /> : <LoadingPage message="正在确认账号状态…" />;
  if (identity.isPending || (identity.isFetching && identity.data?.session && !workspaceRoute))
    return workspaceRoute ? <WorkspaceLoadingPage /> : <LoadingPage />;
  if (identity.isError || !identity.data)
    return (
      <AuthFrame>
        <div className="flex flex-col gap-6">
          <h1 className="text-2xl font-semibold">暂时无法读取工作区</h1>
          <ErrorNotice error={identity.error} />
          <Button
            onClick={() => {
              void identity.refetch();
            }}
          >
            重试
          </Button>
        </div>
      </AuthFrame>
    );
  const data = identity.data;
  const section = workspaceSection(location.pathname);
  const active = data.companies?.companies.find(
    (company) => company.id === data.companies?.activeCompanyId,
  );
  const workspace = !data.session ? (
    <Navigate to="/login" replace />
  ) : active ? (
    <CompanySettingsProvider key={`${data.session.user.id}:${data.session.session.id}:${active.id}:${active.role}`} companyId={active.id} userId={data.session.user.id} refresh={reset}>
    <WorkspacePage
      key={active.id}
      identity={data}
      company={active}
      activate={(id) => {
        void change(() => activateCompany(id));
      }}
      logout={logout}
      notice={notice}
      section={section}
    >
      {section === 'home' ? undefined : (
        <WorkspaceRouteView section={section} company={active} emailConfigured={data.setup.email.configured} userId={data.session.user.id} reset={reset} />
      )}
    </WorkspacePage>
    </CompanySettingsProvider>
  ) : (
    <CompanySelection
      identity={data}
      activate={(id) => {
        void change(() => activateCompany(id));
      }}
      logout={logout}
      notice={notice}
    />
  );
  const workspaceView = <>{identity.isFetching && <WorkspaceLoadingPage message="正在确认账号状态…" />}<Activity mode={identity.isFetching ? 'hidden' : 'visible'}>{workspace}</Activity></>;
  return (
    <Routes>
      <Route
        path="/"
        element={
          <Navigate to={data.session ? '/workspace' : '/login'} replace />
        }
      />
      <Route
        path="/login"
        element={
          data.session ? (
            <Navigate to={invitationReturnTo(location.state)} replace />
          ) : (
            <LoginPage
              configured={data.setup.identity.configured}
              reset={reset}
              notice={notice}
              retry={() => {
                void identity.refetch();
              }}
            />
          )
        }
      />
      <Route path={workspaceRoutes.home} element={workspaceView} />
      <Route path={workspaceRoutes.team} element={workspaceView} />
      <Route path={workspaceRoutes.stores} element={workspaceView} />
      <Route path={workspaceRoutes.settings} element={workspaceView} />
      <Route path={workspaceRoutes.policies} element={workspaceView} />
      <Route path={workspaceRoutes.knowledge} element={workspaceView} />
      <Route path={workspaceRoutes.capabilities} element={workspaceView} />
      <Route path={workspaceRoutes.messages} element={workspaceView} />
      <Route path={workspaceRoutes.products} element={workspaceView} />
      <Route path={workspaceRoutes.orders} element={workspaceView} />
      <Route path={workspaceRoutes.accounting} element={workspaceView} />
      <Route path={workspaceRoutes.activity} element={workspaceView} />
      <Route path="/invite/:id" element={<InvitationPage identity={data} reset={reset} logout={logout} />} />
      <Route
        path="*"
        element={
          !data.session ? (
            <Navigate to="/login" replace />
          ) : (
            <AuthFrame>
              <div className="flex flex-col gap-4">
                <h1 className="text-2xl font-semibold">页面尚未开放</h1>
                <p className="text-sm text-muted-foreground">
                  请返回公司工作区查看当前可用功能。
                </p>
                <Button
                  onClick={() => {
                    window.location.assign('/workspace');
                  }}
                >
                  返回工作区
                </Button>
              </div>
            </AuthFrame>
          )
        }
      />
    </Routes>
  );
}

/**
 * Maps a workspace section to its page. Keeping this in one switch replaces the
 * previous nested ternary and makes route additions a single-line change.
 */
function WorkspaceRouteView({
  section,
  company,
  emailConfigured,
  userId,
  reset,
}: {
  section: WorkspaceSection;
  company: Company;
  emailConfigured: boolean;
  userId: string;
  reset: (notice?: unknown) => Promise<void>;
}) {
  switch (section) {
    case 'accounting':
      return <AccountingPage key={company.id} company={company} />;
    case 'capabilities':
      return <CapabilitiesPage company={company} refresh={reset} />;
    case 'knowledge':
      return <KnowledgePage company={company} refresh={reset} />;
    case 'policies':
      return <ReplyPoliciesPage company={company} refresh={reset} />;
    case 'settings':
      return <CompanySettingsPage />;
    case 'team':
      return (
        <TeamPage
          company={company}
          emailConfigured={emailConfigured}
          userId={userId}
          refresh={reset}
        />
      );
    case 'stores':
      return <StoresPage company={company} refresh={reset} />;
    case 'messages':
      return <MessagesPage company={company} userId={userId} refresh={reset} />;
    case 'products':
      return <ProductsPage company={company} />;
    case 'orders':
      return <OrdersPage company={company} />;
    case 'activity':
      return <ActivityPage company={company} refresh={reset} />;
    default:
      return null;
  }
}
