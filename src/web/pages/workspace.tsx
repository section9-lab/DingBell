import type { ComponentProps, CSSProperties, ReactNode } from 'react';
import { Link } from 'react-router';
import {
  ArrowRight,
  BookOpen,
  Building2,
  Check,
  ChevronsUpDown,
  ChevronRight,
  Clock3,
  CircleHelp,
  History,
  Inbox,
  LayoutDashboard,
  LogOut,
  PackageSearch,
  ShoppingBag,
  Settings,
  SlidersHorizontal,
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
  Brand,
  ErrorNotice,
  roleLabel,
} from '../components/identity-shared';
import { useCompanySettings } from '../components/company-settings-provider';
import { WorkspaceExitProvider, useWorkspaceExit } from '../components/workspace-exit';
import type { Company, Identity } from '../lib/api';
import { WorkspaceHome } from '../components/workspace-home';
import { NavigationSelection } from '../components/motion';

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
      { name: 'FBS 订单', icon: ShoppingBag, section: 'orders', to: '/workspace/orders' },
      { name: '会话日志', icon: History, section: 'activity', to: '/workspace/activity' },
    ],
  },
  {
    title: '客服配置',
    items: [
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

type WorkspaceProps = Props & { company: Company; children?: ReactNode; section?: 'home' | 'team' | 'stores' | 'messages' | 'products' | 'orders' | 'activity' | 'settings' | 'policies' | 'knowledge' };
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
  const { confirmExit } = useWorkspaceExit();
  return (
    <SidebarProvider style={{ '--sidebar-width': 'var(--workspace-sidebar-width)' } as CSSProperties}>
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:top-3 focus:left-3 focus:z-50 focus:rounded-md focus:bg-background focus:p-3"
      >
        跳到主要内容
      </a>
      <Sidebar collapsible="icon">
        <SidebarHeader className="gap-5 px-3 pt-5 pb-2 group-data-[collapsible=icon]:gap-2 group-data-[collapsible=icon]:p-2">
          <Brand />
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="outline"
                  className="h-auto w-full justify-start gap-2.5 bg-background px-3 py-2.5 group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:p-2"
                  aria-label="切换公司"
                  title="切换公司"
                />
              }
            >
              <Building2 aria-hidden="true" />
              <span className="flex min-w-0 flex-1 flex-col items-start gap-0.5 group-data-[collapsible=icon]:hidden">
                <span className="max-w-full truncate">{company.name}</span>
                <span className="text-xs text-muted-foreground">
                  公司工作区
                </span>
              </span>
              <ChevronsUpDown className="group-data-[collapsible=icon]:hidden" aria-hidden="true" />
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
          {groups.map((group) => (
            <SidebarGroup key={group.title}>
              <SidebarGroupLabel className="mb-1 text-xs font-medium">{group.title}</SidebarGroupLabel>
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
            </SidebarGroup>
          ))}
        </SidebarContent>
        <SidebarFooter className="gap-3 p-3 group-data-[collapsible=icon]:items-center group-data-[collapsible=icon]:gap-2 group-data-[collapsible=icon]:p-2">
          <div className="flex items-center gap-2 text-xs text-muted-foreground group-data-[collapsible=icon]:hidden">
            <CircleHelp className="size-4" />
            联系部署管理员获取帮助
          </div>
          <Separator className="group-data-[collapsible=icon]:hidden" />
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  className="h-auto w-full justify-start gap-2 px-2 py-2 group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:p-0"
                  aria-label={`打开账户菜单：${identity.session?.user.email ?? ''}`}
                  title={identity.session?.user.email ?? '账户菜单'}
                />
              }
            >
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-xs font-semibold text-primary-foreground" aria-hidden="true">
                {accountInitials(identity.session?.user.name, identity.session?.user.email)}
              </span>
              <span className="flex min-w-0 flex-1 flex-col items-start gap-0.5 group-data-[collapsible=icon]:hidden">
                <span className="max-w-full truncate text-sm font-medium">{identity.session?.user.name}</span>
                <span className="max-w-full truncate text-xs text-muted-foreground">{identity.session?.user.email}</span>
              </span>
              <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground group-data-[collapsible=icon]:hidden" aria-hidden="true" />
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
        </SidebarFooter>
        <SidebarRail aria-label="展开或收起侧边栏" title="展开或收起侧边栏" />
      </Sidebar>
      <SidebarInset className="min-w-0">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b bg-background px-4 md:px-5">
          <SidebarTrigger aria-label="打开或收起导航" className="text-muted-foreground" />
          <Separator orientation="vertical" className="h-4" />
          <nav aria-label="当前位置" className="flex min-w-0 items-center gap-2 text-sm">
            <span className="hidden max-w-40 truncate text-muted-foreground sm:block" title={company.name}>{company.name}</span>
            <ChevronRight className="hidden size-3.5 shrink-0 text-muted-foreground/60 sm:block" aria-hidden="true" />
            <span className="truncate font-medium">{section === 'home' ? '开始使用' : groups.flatMap(group => group.items).find(item => item.section === section)?.name}</span>
          </nav>
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
