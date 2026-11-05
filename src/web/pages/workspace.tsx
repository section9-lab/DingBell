import type { ComponentProps, CSSProperties, ReactNode } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import {
  ArrowRight,
  BookOpen,
  Building2,
  Calculator,
  Check,
  ChevronsUpDown,
  ChevronDown,
  CircleHelp,
  Clock3,
  History,
  Inbox,
  LayoutDashboard,
  ListChecks,
  LogOut,
  PackageSearch,
  Plus,
  Search,
  ShoppingBag,
  Settings,
  SlidersHorizontal,
  Sparkles,
  Store,
  Users,
} from 'lucide-react';
import { Button } from '../components/ui/button';
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
  DropdownMenuTrigger,
} from '../components/ui/dropdown-menu';
import { Dialog, DialogContent, DialogTitle } from '../components/ui/dialog';
import { Input } from '../components/ui/input';
import { Separator } from '../components/ui/separator';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from '../components/ui/sidebar';
import {
  AuthFrame,
  ErrorNotice,
  roleLabel,
} from '../components/identity-shared';
import { DingBellLogo } from '../components/dingbell-logo';
import { useCompanySettings } from '../components/company-settings-provider';
import { WorkspaceExitProvider, useWorkspaceExit } from '../components/workspace-exit';
import type { Company, Identity } from '../lib/api';
import { WorkspaceHome } from '../components/workspace-home';
import { NavigationSelection } from '../components/motion';
import {useCompanyRealtime} from '../hooks/use-company-realtime';

type Props = {
  identity: Identity;
  activate: (id: string) => void;
  logout: () => void;
  notice?: unknown;
};

function accountInitials(name: string | undefined, email: string | undefined) {
  const source = name?.trim() || email?.split('@')[0]?.trim() || '?';
  return Array.from(source).slice(0, 2).join('').toLocaleUpperCase();
}

function NavigationLink(props: ComponentProps<typeof Link>) {
  const { setOpenMobile } = useSidebar();
  return <Link {...props} onClick={event => {
    props.onClick?.(event);
    if (!event.defaultPrevented) setOpenMobile(false);
  }} />;
}

function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [query, setQuery] = useState('');
  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);
  const keyword = query.trim().toLowerCase();
  const results = useMemo(() => (
    keyword
      ? paletteItems.filter(item => item.name.toLowerCase().includes(keyword) || item.to.toLowerCase().includes(keyword))
      : paletteItems
  ), [keyword]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false} className="top-[18%] max-w-md translate-y-0 gap-2 p-3">
        <DialogTitle className="sr-only">搜索页面</DialogTitle>
        <div className="flex items-center gap-2 border-b pb-2">
          <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <Input
            autoFocus
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder="搜索页面…"
            aria-label="搜索页面"
            className="h-7 border-none bg-transparent px-0 focus-visible:ring-0"
          />
          <kbd className="rounded border bg-muted px-1.5 py-0.5 font-sans text-[10px] text-muted-foreground">Esc</kbd>
        </div>
        <nav aria-label="搜索结果" className="max-h-72 overflow-y-auto">
          {results.length ? (
            <ul className="flex flex-col gap-0.5">
              {results.map(({ name, icon: Icon, to }) => (
                <li key={to}>
                  <NavigationLink
                    to={to}
                    onClick={() => onOpenChange(false)}
                    className="flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm outline-none hover:bg-muted focus-visible:bg-muted"
                  >
                    <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <span className="truncate">{name}</span>
                  </NavigationLink>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-2 py-6 text-center text-xs text-muted-foreground">没有匹配的页面</p>
          )}
        </nav>
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
              <h1 className="text-2xl font-semibold tracking-tight">
                选择公司
              </h1>
              <p className="text-sm text-muted-foreground">
                选择本次要进入的工作区。
              </p>
            </div>
            <div className="flex flex-col gap-3">
              {companies.map((company) => (
                <Button
                  key={company.id}
                  variant="outline"
                  className="h-auto w-full justify-between gap-3 px-4 py-4"
                  onClick={() => activate(company.id)}
                  aria-label={company.name}
                >
                  <Building2 aria-hidden="true" />
                  <span className="flex min-w-0 flex-1 flex-col items-start gap-1">
                    <span className="max-w-full truncate">{company.name}</span>
                    <span className="text-xs text-muted-foreground">
                      {roleLabel(company.role)}
                    </span>
                  </span>
                  <ArrowRight aria-hidden="true" />
                </Button>
              ))}
            </div>
          </>
        ) : (
          <Empty className="px-0">
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

const groups = [
  {
    title: '工作台',
    items: [
      { name: '消息中心', icon: Inbox, section: 'messages', to: '/workspace/messages' },
      { name: '商品资料', icon: PackageSearch, section: 'products', to: '/workspace/products' },
      { name: '订单中心', icon: ShoppingBag, section: 'orders', to: '/workspace/orders' },
      { name: '核算中心', icon: Calculator, section: 'accounting', to: '/workspace/accounting' },
      { name: '会话日志', icon: History, section: 'activity', to: '/workspace/activity' },
    ],
  },
  {
    title: '客服配置',
    items: [
      { name: '能力与数据', icon: ListChecks, section: 'capabilities', to: '/workspace/capabilities' },
      { name: '知识库', icon: BookOpen, section: 'knowledge', to: '/workspace/knowledge' },
      { name: '回复策略', icon: SlidersHorizontal, section: 'policies', to: '/workspace/reply-policies' },
    ],
  },
  {
    title: '组织管理',
    items: [
      { name: '店铺管理', icon: Store, section: 'stores', to: '/workspace/stores' },
      { name: '团队成员', icon: Users, section: 'team', to: '/workspace/team' },
      { name: '公司设置', icon: Settings, section: 'settings', to: '/workspace/settings' },
    ],
  },
];

const paletteItems = [
  { name: '开始使用', icon: LayoutDashboard, to: '/workspace' },
  ...groups.flatMap(group => group.items.map(({ name, icon, to }) => ({ name, icon, to }))),
];

const createMenuItems = [
  { name: '添加店铺', icon: Store, to: '/workspace/stores' },
  { name: '邀请团队成员', icon: Users, to: '/workspace/team' },
  { name: '导入知识库', icon: BookOpen, to: '/workspace/knowledge' },
];

function FooterIconLink({ to, icon: Icon, label }: { to: string; icon: typeof Inbox; label: string }) {
  return (
    <NavigationLink
      to={to}
      aria-label={label}
      title={label}
      className="flex size-8 items-center justify-center rounded-full text-muted-foreground outline-none transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Icon className="size-4" aria-hidden="true" />
    </NavigationLink>
  );
}

type WorkspaceProps = Props & { company: Company; children?: ReactNode; section?: 'home' | 'team' | 'stores' | 'messages' | 'products' | 'orders' | 'accounting' | 'activity' | 'settings' | 'policies' | 'knowledge' | 'capabilities' };
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
  const { query, timeZone } = useCompanySettings();
  const realtime=useCompanyRealtime(company.id,company.role);
  const { confirmExit } = useWorkspaceExit();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === 'k' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setPaletteOpen(value => !value);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
  return (
    <SidebarProvider style={{ '--sidebar-width': 'var(--workspace-sidebar-width)' } as CSSProperties}>
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:top-3 focus:left-3 focus:z-50 focus:rounded-md focus:bg-background focus:p-3"
      >
        跳到主要内容
      </a>
      <Sidebar collapsible="icon">
        <SidebarHeader className="gap-3 px-3 pt-4 pb-2 group-data-[collapsible=icon]:gap-2 group-data-[collapsible=icon]:p-2">
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  className="h-auto w-full justify-start gap-2.5 px-2 py-1.5 group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:p-2"
                  aria-label="切换公司"
                  title="切换公司"
                />
              }
            >
              <DingBellLogo className="size-8 shrink-0" aria-hidden="true" />
              <span className="flex min-w-0 flex-1 flex-col items-start group-data-[collapsible=icon]:hidden">
                <span className="max-w-full truncate text-sm font-semibold tracking-tight">{company.name}</span>
                <span className="max-w-full truncate text-xs text-muted-foreground">
                  公司工作区
                </span>
              </span>
              <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground group-data-[collapsible=icon]:hidden" aria-hidden="true" />
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuGroup>
                <DropdownMenuLabel>切换公司</DropdownMenuLabel>
                {identity.companies?.companies.map((item) => (
                  <DropdownMenuItem
                    key={item.id}
                    onClick={() => item.id !== company.id && confirmExit(() => activate(item.id))}
                  >
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="truncate">{item.name}</span>
                      <span className="text-xs text-muted-foreground">
                        {roleLabel(item.role)}
                      </span>
                    </span>
                    {item.id === company.id && <Check aria-label="当前公司" />}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  className="h-8 w-full justify-start gap-2 bg-[#7856ff] px-2.5 text-xs font-medium text-white hover:bg-[#6847f0] group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0"
                  aria-label="创建新"
                  title="创建新"
                />
              }
            >
              <Plus className="size-4 shrink-0" aria-hidden="true" />
              <span className="group-data-[collapsible=icon]:hidden">创建新</span>
              <ChevronDown className="ml-auto size-3.5 shrink-0 text-white/80 group-data-[collapsible=icon]:hidden" aria-hidden="true" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-48">
              <DropdownMenuGroup>
                {createMenuItems.map(({ name, icon: Icon, to }) => (
                  <DropdownMenuItem key={name} render={<NavigationLink to={to} />}>
                    <Icon aria-hidden="true" />
                    {name}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            aria-label="搜索页面（Command K）"
            aria-keyshortcuts="Meta+K Control+K"
            className="flex h-8 w-full shrink-0 items-center gap-2 rounded-md bg-muted/70 px-2.5 text-xs text-muted-foreground outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0"
          >
            <Search className="size-3.5 shrink-0" aria-hidden="true" />
            <span className="group-data-[collapsible=icon]:hidden">搜索</span>
            <kbd className="ml-auto rounded border bg-background px-1 py-px font-sans text-[10px] leading-4 text-muted-foreground group-data-[collapsible=icon]:hidden">⌘K</kbd>
          </button>
        </SidebarHeader>
        <SidebarContent className="gap-2 px-1">
          <SidebarGroup>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton className="relative isolate h-9 data-active:bg-transparent" tooltip="开始使用" isActive={section === 'home'} aria-current={section === 'home' ? 'page' : undefined} render={<NavigationLink to="/workspace" />}>
                  <NavigationSelection active={section === 'home'} />
                  <LayoutDashboard />
                  <span>开始使用</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroup>
          {groups.map((group) => {
            const collapsed = collapsedGroups[group.title] ?? false;
            return (
              <SidebarGroup key={group.title}>
                <SidebarGroupLabel
                  render={
                    <button
                      type="button"
                      onClick={() => setCollapsedGroups(previous => ({ ...previous, [group.title]: !collapsed }))}
                      aria-expanded={!collapsed}
                      className="mt-1 h-7 w-full cursor-pointer items-center justify-between border-t border-sidebar-border/70 pt-0 text-[11px] font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring group-data-[collapsible=icon]:hidden"
                      title={group.title}
                    />
                  }
                >
                  {group.title}
                  <ChevronDown aria-hidden="true" className={'size-3.5 shrink-0 text-muted-foreground/70 transition-transform' + (collapsed ? ' -rotate-90' : '')} />
                </SidebarGroupLabel>
                {!collapsed && (
                  <SidebarGroupContent>
                    <SidebarMenu>
                      {group.items.map(({ name, icon: Icon, section: target, to }) => (
                        <SidebarMenuItem key={name}>
                          <SidebarMenuButton className="relative isolate h-9 data-active:bg-transparent" tooltip={name}
                            isActive={section === target} aria-current={section === target ? 'page' : undefined}
                            aria-label={name} render={<NavigationLink to={to} />}>
                            <NavigationSelection active={section === target} />
                            <Icon />
                            <span>{name}</span>
                          </SidebarMenuButton>
                        </SidebarMenuItem>
                      ))}
                    </SidebarMenu>
                  </SidebarGroupContent>
                )}
              </SidebarGroup>
            );
          })}
        </SidebarContent>
        <SidebarFooter className="gap-3 p-3 group-data-[collapsible=icon]:items-center group-data-[collapsible=icon]:gap-2 group-data-[collapsible=icon]:p-2">
          <div className="flex items-start gap-2.5 rounded-lg bg-[#7856ff] px-3 py-2.5 text-white group-data-[collapsible=icon]:hidden">
            <Sparkles className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <div className="flex min-w-0 flex-col gap-0.5">
              <p className="text-xs font-semibold">需要帮助？</p>
              <p className="text-xs leading-5 text-white/85">联系部署管理员获取帮助</p>
            </div>
          </div>
          <div className="flex items-center justify-between gap-2 group-data-[collapsible=icon]:justify-center">
            <div className="flex items-center gap-1 group-data-[collapsible=icon]:hidden">
              <FooterIconLink to="/workspace" icon={LayoutDashboard} label="开始使用" />
              <FooterIconLink to="/workspace/messages" icon={Inbox} label="消息中心" />
              <FooterIconLink to="/workspace/settings" icon={Settings} label="公司设置" />
              <span
                role="img"
                className="flex size-8 cursor-default items-center justify-center rounded-full text-muted-foreground"
                aria-label="联系部署管理员获取帮助"
                title="联系部署管理员获取帮助"
              >
                <CircleHelp className="size-4" aria-hidden="true" />
              </span>
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="ghost"
                    className="size-8 justify-center rounded-full p-0"
                    aria-label={`打开账户菜单：${identity.session?.user.email ?? ''}`}
                    title={identity.session?.user.name ?? '账户菜单'}
                  />
                }
              >
                <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-[#7856ff] text-xs font-semibold text-white" aria-hidden="true">
                  {accountInitials(identity.session?.user.name, identity.session?.user.email)}
                </span>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="right" align="end" className="w-64">
                <DropdownMenuGroup>
                  <DropdownMenuLabel className="mb-1 flex flex-col gap-1 border-b px-2 py-2">
                    <span className="truncate text-sm font-medium text-foreground">{identity.session?.user.name}</span>
                    <span className="truncate font-normal">{identity.session?.user.email}</span>
                  </DropdownMenuLabel>
                  <DropdownMenuItem variant="destructive" onClick={() => confirmExit(logout)}>
                    <LogOut />
                    退出登录
                  </DropdownMenuItem>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </SidebarFooter>
        <SidebarRail aria-label="展开或收起侧边栏" title="展开或收起侧边栏" />
      </Sidebar>
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
      <SidebarInset className="min-w-0">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b bg-background px-4 md:px-5">
          {/* 仅移动端保留导航开关：桌面端由侧边栏拖拽边缘收起/展开 */}
          <SidebarTrigger className="text-muted-foreground md:hidden" aria-label="打开或收起导航" />
          <Separator orientation="vertical" className="h-4 md:hidden" />
          <nav aria-label="当前位置" className="flex min-w-0 items-center gap-2 text-sm">
            <span className="hidden max-w-40 truncate text-muted-foreground sm:block" title={company.name}>{company.name}</span>
            <span className="hidden text-muted-foreground/50 sm:block" aria-hidden="true">/</span>
            <span className="truncate font-medium">{section === 'home' ? '开始使用' : groups.flatMap(group => group.items).find(item => item.section === section)?.name}</span>
          </nav>
          <span role="status" className="hidden shrink-0 text-xs text-muted-foreground sm:inline">{realtime==='connected'?'实时已连接':realtime==='unavailable'?'实时不可用，请手动刷新':realtime==='reconnecting'?'实时重连中':'正在连接实时更新'}</span>
          <NavigationLink to="/workspace/settings" className="ml-auto flex min-w-0 max-w-1/2 shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
            title={query.isError ? `时区读取失败，暂按 ${timeZone} 显示，请进入公司设置重试。` : `公司时区：${timeZone}`}>
            <Clock3 className="size-3.5 shrink-0" aria-hidden="true" />
            <span className="truncate">{query.isError ? `时区读取失败 · ${timeZone}` : query.isPending ? '时区读取中 · UTC' : timeZone}</span>
          </NavigationLink>
        </header>
        <div
          id="main-content"
          tabIndex={-1}
          className={section === 'messages' ? 'flex h-[calc(100svh-3.5rem)] min-h-0 min-w-0 flex-col gap-3 overflow-hidden p-3 md:p-5' : 'mx-auto flex w-full max-w-5xl flex-col gap-8 px-5 py-7 sm:px-8 lg:py-10'}
        >
          {notice != null && <ErrorNotice error={notice} />}
          {children ?? <WorkspaceHome company={company} />}
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
