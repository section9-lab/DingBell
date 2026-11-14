import type { ComponentProps, ReactNode } from 'react';
import { Fragment, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import {
  ArrowUp,
  Bell,
  BookOpen,
  Building2,
  Calculator,
  Check,
  ChevronDown,
  History,
  Inbox,
  LayoutDashboard,
  ListChecks,
  LogOut,
  Menu,
  Monitor,
  PackageSearch,
  Plus,
  Search,
  Settings,
  ShoppingBag,
  SlidersHorizontal,
  Store,
  Users,
} from 'lucide-react';
import { Button } from '../components/ui/button';
import { Autocomplete } from '@base-ui/react/autocomplete';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '../components/ui/empty';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../components/ui/dropdown-menu';
import { Dialog, DialogContent, DialogTitle } from '../components/ui/dialog';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '../components/ui/sheet';
import { Separator } from '../components/ui/separator';
import {
  AuthFrame,
  ErrorNotice,
  roleLabel,
} from '../components/identity-shared';
import { WorkspaceExitProvider, useWorkspaceExit } from '../components/workspace-exit';
import type { Company, Identity } from '../lib/api';
import { WorkspaceHome } from '../components/workspace-home';
import { UserAvatar } from '../components/user-avatar';
import { defaultAvatarSeed } from '../lib/avatar';
import { workspaceRoutes, type WorkspaceSection } from '../lib/routes';
import { useCompanyRealtime } from '../hooks/use-company-realtime';

type Props = {
  identity: Identity;
  activate: (id: string) => void;
  logout: () => void;
  notice?: unknown;
};

function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const navigate = useNavigate();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false} className="top-[16%] max-w-lg translate-y-0 gap-0 overflow-hidden rounded-[14px] p-0">
        <DialogTitle className="sr-only">搜索页面</DialogTitle>
        <Autocomplete.Root
          items={paletteItems}
          inline
          open
          autoHighlight="always"
          itemToStringValue={(item) => item.name}
          filter={(item, query) => {
            const keyword = query.trim().toLowerCase();
            return (
              !keyword ||
              item.name.toLowerCase().includes(keyword) ||
              item.to.toLowerCase().includes(keyword)
            );
          }}
        >
          <div className="flex items-center gap-3 border-b border-border px-4 py-3.5">
            <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <Autocomplete.Input
              autoFocus
              placeholder="搜索页面或功能…"
              aria-label="搜索页面"
              className="h-7 w-full min-w-0 border-none bg-transparent px-0 text-sm outline-none placeholder:text-[var(--text-3)] focus-visible:ring-0"
            />
            <kbd className="rounded border border-border bg-[var(--bg-sunken)] px-1.5 py-0.5 font-sans text-[10px] text-muted-foreground">Esc</kbd>
          </div>
          <Autocomplete.List
            aria-label="搜索结果"
            className="max-h-80 overflow-y-auto overscroll-contain p-1.5"
          >
            {(item) => (
              <Autocomplete.Item
                key={item.to}
                value={item}
                onClick={() => {
                  onOpenChange(false);
                  navigate(item.to);
                }}
                className="flex cursor-default items-center gap-3 rounded-lg px-3 py-2.5 text-[13.5px] outline-none select-none data-highlighted:bg-[var(--bg-hover)] data-highlighted:text-foreground"
              >
                <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-[var(--bg-sunken)] text-[var(--text-2)]">
                  <item.icon className="size-4" aria-hidden="true" />
                </span>
                <span className="truncate">{item.name}</span>
                <span className="ml-auto truncate text-[11px] text-[var(--text-3)]">{item.to}</span>
              </Autocomplete.Item>
            )}
          </Autocomplete.List>
          <Autocomplete.Empty>
            <p className="px-2 py-8 text-center text-xs text-muted-foreground">没有匹配的页面</p>
          </Autocomplete.Empty>
        </Autocomplete.Root>
      </DialogContent>
    </Dialog>
  );
}

export function CompanySelection({
  identity,
  activate,
  logout,
  notice,
}: Props) {
  const companies = identity.companies?.companies ?? [];
  return (
    <AuthFrame>
      <div className="flex flex-col gap-6">
        {notice != null && <ErrorNotice error={notice} />}
        {companies.length ? (
          <>
            <div className="flex flex-col gap-2">
              <h1 className="page-title">选择公司</h1>
              <p className="page-subtitle">选择本次要进入的工作区。</p>
            </div>
            <div className="flex flex-col gap-2">
              {companies.map((company) => (
                <Button
                  key={company.id}
                  variant="outline"
                  className="h-auto w-full justify-between gap-3 px-3.5 py-3"
                  onClick={() => activate(company.id)}
                  aria-label={company.name}
                >
                  <span className="flex size-8 items-center justify-center rounded-lg bg-[var(--bg-sunken)] text-[var(--text-2)]">
                    <Building2 className="size-4" aria-hidden="true" />
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
                    <span className="max-w-full truncate text-[13.5px] font-medium">{company.name}</span>
                    <span className="text-xs text-muted-foreground">{roleLabel(company.role)}</span>
                  </span>
                  <ChevronDown className="size-4 -rotate-90 text-muted-foreground" aria-hidden="true" />
                </Button>
              ))}
            </div>
          </>
        ) : (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Building2 />
              </EmptyMedia>
              <EmptyTitle>
                <h1>尚未加入公司</h1>
              </EmptyTitle>
              <EmptyDescription>
                这个账号暂无可访问的公司。请打开同事发送的邀请链接，或联系公司所有者确认成员资格。
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <p className="break-all text-sm text-muted-foreground">
                {identity.session?.user.email}
              </p>
            </EmptyContent>
          </Empty>
        )}
        <Separator />
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="min-w-0 break-all text-xs text-muted-foreground">
            {identity.session?.user.email}
          </p>
          <Button variant="ghost" onClick={logout}>
            <LogOut data-icon="inline-start" />
            退出登录
          </Button>
        </div>
      </div>
    </AuthFrame>
  );
}

type WorkspaceNavItem = { name: string; icon: typeof Inbox; section: WorkspaceSection; to: string };
const groups: { title: string; items: WorkspaceNavItem[] }[] = [
  {
    title: '工作台',
    items: [
      { name: '开始使用', icon: LayoutDashboard, section: 'home', to: workspaceRoutes.home },
      { name: '消息中心', icon: Inbox, section: 'messages', to: workspaceRoutes.messages },
      { name: '商品资料', icon: PackageSearch, section: 'products', to: workspaceRoutes.products },
      { name: '订单中心', icon: ShoppingBag, section: 'orders', to: workspaceRoutes.orders },
      { name: '核算中心', icon: Calculator, section: 'accounting', to: workspaceRoutes.accounting },
      { name: '会话日志', icon: History, section: 'activity', to: workspaceRoutes.activity },
    ],
  },
  {
    title: '客服配置',
    items: [
      { name: '知识库', icon: BookOpen, section: 'knowledge', to: workspaceRoutes.knowledge },
      { name: '回复策略', icon: SlidersHorizontal, section: 'policies', to: workspaceRoutes.policies },
    ],
  },
  {
    title: '组织管理',
    items: [
      { name: '店铺管理', icon: Store, section: 'stores', to: workspaceRoutes.stores },
      { name: '团队成员', icon: Users, section: 'team', to: workspaceRoutes.team },
      { name: '公司设置', icon: Settings, section: 'settings', to: workspaceRoutes.settings },
    ],
  },
];

const allNavItems = groups.flatMap(group => group.items);
const railGroups = groups
  .map(group => ({ ...group, items: group.items.filter(item => item.section !== 'home' && item.section !== 'activity') }))
  .filter(group => group.items.length > 0);

const paletteItems = [
  ...allNavItems.map(({ name, icon, to }) => ({ name, icon, to })),
  { name: '能力与数据', icon: ListChecks, to: `${workspaceRoutes.settings}?section=capabilities` },
];

const createMenuItems = [
  { name: '添加店铺', icon: Store, to: workspaceRoutes.stores },
  { name: '邀请团队成员', icon: Users, to: workspaceRoutes.team },
  { name: '导入知识库', icon: BookOpen, to: workspaceRoutes.knowledge },
];

function NavigationLink({ onNavigate, ...props }: ComponentProps<typeof Link> & { onNavigate?: () => void }) {
  return <Link {...props} onClick={event => {
    props.onClick?.(event);
    if (!event.defaultPrevented) onNavigate?.();
  }} />;
}

function CompanySwitcher({
  company,
  identity,
  activate,
  confirmExit,
  onNavigate,
  compact = false,
}: {
  company: Company;
  identity: Identity;
  activate: (id: string) => void;
  confirmExit: (operation: () => void) => void;
  onNavigate?: () => void;
  compact?: boolean;
}) {
  const mark = Array.from(company.name.trim())[0] ?? '?';
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            className={compact ? 'rail-mark' : 'side-row'}
            aria-label="切换公司"
            title={company.name}
            aria-haspopup="menu"
          />
        }
      >
        {compact ? mark : (
          <>
            <span className="rail-mark size-6 text-[11px]">{mark}</span>
            <span className="min-w-0 flex-1 truncate font-medium">{company.name}</span>
            <ChevronDown className="size-3.5 shrink-0 text-[var(--text-3)]" aria-hidden="true" />
          </>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent side={compact ? 'right' : 'bottom'} align="start" className="w-60">
        <DropdownMenuGroup>
          <DropdownMenuLabel>切换公司</DropdownMenuLabel>
          {identity.companies?.companies.map((item) => (
            <DropdownMenuItem
              key={item.id}
              onClick={() => item.id !== company.id && confirmExit(() => activate(item.id))}
            >
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate">{item.name}</span>
                <span className="text-[11px] text-muted-foreground">{roleLabel(item.role)}</span>
              </span>
              {item.id === company.id && <Check aria-label="当前公司" />}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel>快速创建</DropdownMenuLabel>
          {createMenuItems.map(({ name, icon: Icon, to }) => (
            <DropdownMenuItem key={name} render={<NavigationLink to={to} onNavigate={onNavigate} />}>
              <Icon aria-hidden="true" />
              {name}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function AccountMenu({
  identity,
  confirmExit,
  logout,
  onNavigate,
}: {
  identity: Identity;
  confirmExit: (operation: () => void) => void;
  logout: () => void;
  onNavigate?: () => void;
}) {
  const email = identity.session?.user.email ?? '';
  const name = identity.session?.user.name;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            className="flex size-9 items-center justify-center rounded-full bg-[var(--bg-sunken)] text-[11px] font-semibold text-[var(--text-2)] outline-none ring-1 ring-black/[0.04] transition-colors hover:bg-[var(--bg-hover)] focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={`打开账户菜单：${email}`}
            title={name ?? '账户菜单'}
          />
        }
      >
        <UserAvatar name={name ?? email} image={identity.session?.user.image} seed={identity.session?.user.id ? defaultAvatarSeed(identity.session.user.id) : undefined} size={36} className="ring-0" />
      </DropdownMenuTrigger>
      <DropdownMenuContent side="right" align="end" className="w-64">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="mb-1 flex flex-col gap-1 border-b px-2 py-2">
            <span className="truncate text-sm font-medium text-foreground">{name}</span>
            <span className="truncate font-normal">{email}</span>
          </DropdownMenuLabel>
          <DropdownMenuItem render={<NavigationLink to={workspaceRoutes.settings} onNavigate={onNavigate} />}>
            <Settings aria-hidden="true" />
            公司设置
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onClick={() => confirmExit(logout)}>
            <LogOut />
            退出登录
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function IconRail({
  company,
  identity,
  section,
  activate,
  confirmExit,
  logout,
}: {
  company: Company;
  identity: Identity;
  section: WorkspaceSection;
  activate: (id: string) => void;
  confirmExit: (operation: () => void) => void;
  logout: () => void;
}) {
  return (
    <nav aria-label="快速导航" className="app-rail">
      <CompanySwitcher compact company={company} identity={identity} activate={activate} confirmExit={confirmExit} />
      {railGroups.map((group, index) => (
        <Fragment key={group.title}>
          {index > 0 && <span className="rail-sep" aria-hidden="true" />}
          {group.items.map(item => {
            const Icon = item.icon;
            return (
              <NavigationLink
                key={item.name}
                to={item.to}
                aria-label={item.name}
                data-tip={item.name}
                aria-current={section === item.section ? 'page' : undefined}
                className="rail-btn"
              >
                <Icon className="size-[18px]" aria-hidden="true" />
              </NavigationLink>
            );
          })}
        </Fragment>
      ))}
      <div className="mt-auto flex flex-col items-center gap-2 pt-2">
        <AccountMenu identity={identity} confirmExit={confirmExit} logout={logout} />
      </div>
    </nav>
  );
}

function MobileNav({
  company,
  identity,
  section,
  activate,
  confirmExit,
  logout,
  onNavigate,
}: {
  company: Company;
  identity: Identity;
  section: WorkspaceSection;
  activate: (id: string) => void;
  confirmExit: (operation: () => void) => void;
  logout: () => void;
  onNavigate: () => void;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-border p-3">
        <CompanySwitcher company={company} identity={identity} activate={activate} confirmExit={confirmExit} onNavigate={onNavigate} />
      </div>
      <nav aria-label="功能列表" className="min-h-0 flex-1 overflow-y-auto p-2">
        {groups.map(group => (
          <div key={group.title} className="flex flex-col gap-0.5 pt-2">
            <div className="section-label px-2.5 pt-2 pb-1">{group.title}</div>
            {group.items.map(item => {
              const Icon = item.icon;
              return (
                <NavigationLink
                  key={item.name}
                  to={item.to}
                  onNavigate={onNavigate}
                  className="nav-item"
                  aria-current={section === item.section ? 'page' : undefined}
                >
                  <Icon className="size-[17px] shrink-0" aria-hidden="true" />
                  <span className="truncate">{item.name}</span>
                </NavigationLink>
              );
            })}
          </div>
        ))}
      </nav>
      <div className="flex items-center gap-2.5 border-t border-border p-3">
        <AccountMenu identity={identity} confirmExit={confirmExit} logout={logout} onNavigate={onNavigate} />
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{identity.session?.user.email}</span>
      </div>
    </div>
  );
}

type WorkspaceProps = Props & { company: Company; children?: ReactNode; section?: WorkspaceSection };
export function WorkspacePage(props: WorkspaceProps) {
  return <WorkspaceExitProvider><WorkspaceContent {...props}/></WorkspaceExitProvider>;
}

function WorkspaceContent({
  identity,
  company,
  activate,
  logout,
  notice,
  children,
  section = 'home',
}: WorkspaceProps) {
  // 保持 SSE 订阅以驱动缓存失效与消息状态事件，不展示连接状态。
  useCompanyRealtime(company.id, company.role);
  const { confirmExit } = useWorkspaceExit();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen(value => !value);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
  const content = children ?? <WorkspaceHome company={company} />;
  const common = {
    company,
    identity,
    section,
    activate,
    confirmExit,
    logout,
  };
  return (
    <>
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:top-3 focus:left-3 focus:z-50 focus:rounded-lg focus:bg-card focus:p-3"
      >
        跳到主要内容
      </a>
      <div className="app-shell">
        <IconRail {...common} />

        <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
          <SheetContent side="left" className="w-[280px] gap-0 border-r border-border bg-[var(--canvas-top)] p-0">
            <SheetHeader className="sr-only">
              <SheetTitle>工作区导航</SheetTitle>
              <SheetDescription>切换公司或查看工作区功能。</SheetDescription>
            </SheetHeader>
            <MobileNav {...common} onNavigate={() => setMobileNavOpen(false)} />
          </SheetContent>
        </Sheet>

        <main className="workspace">
          <div className="workspace-panel">
            <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3 lg:hidden">
              <Button variant="ghost" size="icon-sm" aria-label="打开或收起导航" onClick={() => setMobileNavOpen(true)}>
                <Menu />
              </Button>
              <Bell className="size-4" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate text-sm font-semibold">DingBell</span>
              <Button variant="ghost" size="icon-sm" aria-label="搜索页面" onClick={() => setPaletteOpen(true)}>
                <Search />
              </Button>
            </div>

            {section === 'messages' ? (
              <div
                id="main-content"
                tabIndex={-1}
                className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-4 pt-5 pb-3 sm:px-6 sm:pt-6 lg:overflow-hidden"
              >
                {notice != null && <ErrorNotice error={notice} />}
                {content}
              </div>
            ) : (
              <div id="main-content" tabIndex={-1} className="page-scroll">
                <div className={section === 'home' ? 'page-content pb-28' : 'page-content'}>
                  {notice != null && <ErrorNotice error={notice} />}
                  {content}
                </div>
              </div>
            )}
          </div>

          {section === 'home' && !children && (
            <div className="pointer-events-none absolute inset-x-0 bottom-6 flex justify-center px-4">
              <button
                type="button"
                onClick={() => setPaletteOpen(true)}
                aria-label="搜索页面或功能（Command K）"
                className="pointer-events-auto flex h-14 w-full max-w-[860px] items-center gap-3 rounded-full border border-border bg-card px-4 text-left shadow-[0_8px_28px_rgb(0_0_0/0.08)] outline-none transition-shadow hover:shadow-[0_12px_32px_rgb(0_0_0/0.11)] focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className="flex size-8 shrink-0 items-center justify-center rounded-full text-[var(--text-2)]">
                  <Plus className="size-[18px]" aria-hidden="true" />
                </span>
                <Monitor className="size-4 shrink-0 text-[var(--text-3)]" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate text-[14px] text-[var(--text-3)]">搜索页面、打开功能…</span>
                <kbd className="hidden shrink-0 rounded-md border border-border bg-[var(--bg-sunken)] px-1.5 py-0.5 font-sans text-[10px] text-muted-foreground sm:block">⌘K</kbd>
                <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-[var(--bg-sunken)] text-[var(--text-2)]">
                  <ArrowUp className="size-4" aria-hidden="true" />
                </span>
              </button>
            </div>
          )}
        </main>
      </div>
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
    </>
  );
}
