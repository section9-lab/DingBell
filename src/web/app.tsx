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
import { ApiError, activateCompany, readIdentity, signOut } from './lib/api';
import {
  AuthFrame,
  ErrorNotice,
  LoadingPage,
  WorkspaceLoadingPage,
} from './components/identity-shared';
import { CompanySettingsProvider } from './components/company-settings-provider';
import { Button } from './components/ui/button';
import { LoginPage } from './pages/login';
import { invitationReturnTo } from './lib/account-links';
import { clearPendingReplies } from './lib/conversation-reply-pending';
import { clearPendingPreviews } from './lib/conversation-preview-pending';
import { clearAiResumptions } from './lib/ai-reception-pending';
import { clearReplyDrafts } from './lib/conversation-draft';
import { clearConversationPositions } from './lib/conversation-position';

const loadBootstrap = () => import('./pages/bootstrap');
const loadAccountEmail = () => import('./pages/account-email');
const loadTeam = () => import('./pages/team');
const loadStores = () => import('./pages/stores');
const loadCompanySettings = () => import('./pages/company-settings');
const loadKnowledge = () => import('./pages/knowledge');
const loadReplyPolicies = () => import('./pages/reply-policies');
const loadMessages = () => import('./pages/messages');
const loadProducts = () => import('./pages/products');
const loadOrders = () => import('./pages/orders');
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
const ReplyPoliciesPage = lazy(async () => ({ default: (await loadReplyPolicies()).ReplyPoliciesPage }));
const MessagesPage = lazy(async () => ({ default: (await loadMessages()).MessagesPage }));
const ProductsPage = lazy(async () => ({ default: (await loadProducts()).ProductsPage }));
const OrdersPage = lazy(async () => ({ default: (await loadOrders()).OrdersPage }));
const ActivityPage = lazy(async () => ({ default: (await loadActivity()).ActivityPage }));
const InvitationPage = lazy(async () => ({ default: (await loadInvitation()).InvitationPage }));
const CompanySelection = lazy(async () => ({ default: (await loadWorkspace()).CompanySelection }));
const WorkspacePage = lazy(async () => ({ default: (await loadWorkspace()).WorkspacePage }));
const workspaceLoaders: Record<string, () => Promise<unknown>> = {
  '/workspace/team': loadTeam, '/workspace/stores': loadStores, '/workspace/settings': loadCompanySettings,
  '/workspace/knowledge': loadKnowledge, '/workspace/reply-policies': loadReplyPolicies, '/workspace/messages': loadMessages,
  '/workspace/products': loadProducts, '/workspace/orders': loadOrders, '/workspace/activity': loadActivity,
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
  const workspaceRoute = location.pathname === '/' || location.pathname === '/workspace' || location.pathname.startsWith('/workspace/');
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
  const workspaceRoute = location.pathname === '/' || location.pathname === '/workspace' || location.pathname.startsWith('/workspace/');
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
      if (userId) { try { clearPendingReplies(window.sessionStorage, { userId }); clearPendingPreviews(window.sessionStorage, { userId }); clearAiResumptions(window.sessionStorage, { userId }); clearReplyDrafts(window.sessionStorage, { userId }); clearConversationPositions(window.sessionStorage, { userId }); } catch { /* Storage may be unavailable. */ } }
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
      section={location.pathname === '/workspace/knowledge' ? 'knowledge' : location.pathname === '/workspace/reply-policies' ? 'policies' : location.pathname === '/workspace/settings' ? 'settings' : location.pathname === '/workspace/team' ? 'team' : location.pathname === '/workspace/stores' ? 'stores' : location.pathname === '/workspace/messages' ? 'messages' : location.pathname === '/workspace/products' ? 'products' : location.pathname === '/workspace/orders' ? 'orders' : location.pathname === '/workspace/activity' ? 'activity' : 'home'}
    >
      {location.pathname === '/workspace/knowledge' ? <KnowledgePage company={active} refresh={reset} /> : location.pathname === '/workspace/reply-policies' ? <ReplyPoliciesPage company={active} refresh={reset} /> : location.pathname === '/workspace/settings' ? <CompanySettingsPage /> : location.pathname === '/workspace/team' ? <TeamPage company={active} emailConfigured={data.setup.email.configured} userId={data.session.user.id} refresh={reset} /> : location.pathname === '/workspace/stores' ? <StoresPage company={active} refresh={reset} /> : location.pathname === '/workspace/messages' ? <MessagesPage company={active} userId={data.session.user.id} refresh={reset} /> : location.pathname === '/workspace/products' ? <ProductsPage company={active} /> : location.pathname === '/workspace/orders' ? <OrdersPage company={active} /> : location.pathname === '/workspace/activity' ? <ActivityPage company={active} refresh={reset} /> : undefined}
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
      <Route path="/workspace" element={workspaceView} />
      <Route path="/workspace/team" element={workspaceView} />
      <Route path="/workspace/stores" element={workspaceView} />
      <Route path="/workspace/settings" element={workspaceView} />
      <Route path="/workspace/reply-policies" element={workspaceView} />
      <Route path="/workspace/knowledge" element={workspaceView} />
      <Route path="/workspace/messages" element={workspaceView} />
      <Route path="/workspace/products" element={workspaceView} />
      <Route path="/workspace/orders" element={workspaceView} />
      <Route path="/workspace/activity" element={workspaceView} />
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
