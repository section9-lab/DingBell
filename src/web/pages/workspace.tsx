import type { ComponentProps, CSSProperties, ReactNode } from 'react';
import { Link } from 'react-router';
import {
  ArrowRight,
  BookOpen,
  Building2,
  Check,
  ChevronsUpDown,
  CircleHelp,
  History,
  Inbox,
  LayoutDashboard,
  LogOut,
  Settings,
  SlidersHorizontal,
  Store,
  Users,
  UserRound,
} from 'lucide-react';
import { Badge } from '../components/ui/badge';
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

type Props = {
  identity: Identity;
  activate: (id: string) => void;
  logout: () => void;
  notice?: unknown;
};

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
      { name: '消息中心', icon: Inbox },
      { name: '会话日志', icon: History },
    ],
  },
  {
    title: '客服配置',
    items: [
      { name: '知识库', icon: BookOpen },
      { name: '回复策略', icon: SlidersHorizontal },
    ],
  },
  {
    title: '组织管理',
    items: [
      { name: '店铺管理', icon: Store },
      { name: '团队成员', icon: Users },
      { name: '公司设置', icon: Settings },
    ],
  },
];

type WorkspaceProps = Props & { company: Company; children?: ReactNode; section?: 'home' | 'team' | 'stores' | 'messages' | 'settings' | 'policies' | 'knowledge' };
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
    <SidebarProvider style={{ '--sidebar-width': '14rem' } as CSSProperties}>
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:top-3 focus:left-3 focus:z-50 focus:rounded-md focus:bg-background focus:p-3"
      >
        跳到主要内容
      </a>
      <Sidebar collapsible="offcanvas">
        <SidebarHeader className="gap-7 px-4 pt-6 pb-3">
          <Brand />
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="outline"
                  className="h-auto w-full justify-start gap-2.5 px-3 py-3"
                  aria-label="切换公司"
                />
              }
            >
              <Building2 aria-hidden="true" />
              <span className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
                <span className="max-w-full truncate">{company.name}</span>
                <span className="text-xs text-muted-foreground">
                  公司工作区
                </span>
              </span>
              <ChevronsUpDown aria-hidden="true" />
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
        <SidebarContent>
          <SidebarGroup>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton isActive={section === 'home'} aria-current={section === 'home' ? 'page' : undefined} render={<NavigationLink to="/workspace" />}>
                  <LayoutDashboard />
                  <span>开始使用</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroup>
          {groups.map((group) => (
            <SidebarGroup key={group.title}>
              <SidebarGroupLabel>{group.title}</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {group.items.map(({ name, icon: Icon }) => (
                    <SidebarMenuItem key={name}>
                      <SidebarMenuButton
                        disabled={!['团队成员', '店铺管理', '消息中心', '公司设置', '回复策略', '知识库'].includes(name)}
                        isActive={(name === '团队成员' && section === 'team') || (name === '店铺管理' && section === 'stores') || (name === '消息中心' && section === 'messages') || (name === '公司设置' && section === 'settings') || (name === '回复策略' && section === 'policies') || (name === '知识库' && section === 'knowledge')}
                        aria-current={(name === '团队成员' && section === 'team') || (name === '店铺管理' && section === 'stores') || (name === '消息中心' && section === 'messages') || (name === '公司设置' && section === 'settings') || (name === '回复策略' && section === 'policies') || (name === '知识库' && section === 'knowledge') ? 'page' : undefined}
                        aria-label={['团队成员', '店铺管理', '消息中心', '公司设置', '回复策略', '知识库'].includes(name) ? name : `${name}，尚未开放`}
                        {...(name === '知识库' ? { render: <NavigationLink to="/workspace/knowledge" /> } : name === '团队成员' ? { render: <NavigationLink to="/workspace/team" /> } : name === '店铺管理' ? { render: <NavigationLink to="/workspace/stores" /> } : name === '消息中心' ? { render: <NavigationLink to="/workspace/messages" /> } : name === '回复策略' ? { render: <NavigationLink to="/workspace/reply-policies" /> } : name === '公司设置' ? { render: <NavigationLink to="/workspace/settings" /> } : {})}
                      >
                        <Icon />
                        <span>{name}</span>
                        {!['团队成员', '店铺管理', '消息中心', '公司设置', '回复策略', '知识库'].includes(name) && <span className="ml-auto text-[10px]">未开放</span>}
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          ))}
        </SidebarContent>
        <SidebarFooter className="gap-4 p-4">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <CircleHelp className="size-4" />
            需要帮助？请联系部署管理员
          </div>
          <Separator />
          <div className="flex min-w-0 items-center gap-2">
            <UserRound className="size-4 shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">
                {identity.session?.user.name}
              </p>
              <p className="text-xs text-muted-foreground">
                {roleLabel(company.role)}
              </p>
            </div>
          </div>
          <Button variant="ghost" className="justify-start" onClick={() => confirmExit(logout)}>
            <LogOut data-icon="inline-start" />
            退出登录
          </Button>
        </SidebarFooter>
      </Sidebar>
      <SidebarInset className="min-w-0">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b px-4 md:px-6">
          <SidebarTrigger aria-label="打开或收起导航" />
          <Separator orientation="vertical" className="h-4" />
          <span className="truncate text-sm text-muted-foreground">
            {company.name}
          </span>
          <span className="text-muted-foreground" aria-hidden="true">
            /
          </span>
          <span className="text-sm">{section === 'knowledge' ? '知识库' : section === 'policies' ? '回复策略' : section === 'settings' ? '公司设置' : section === 'team' ? '团队成员' : section === 'stores' ? '店铺管理' : section === 'messages' ? '消息中心' : '开始使用'}</span>
          <NavigationLink to="/workspace/settings" className="ml-auto max-w-[50%] truncate text-xs text-muted-foreground" title={query.isError ? `时区读取失败，暂按 ${timeZone} 显示，请进入公司设置重试。` : `公司时区：${timeZone}`} >{query.isError ? `时区读取失败 · ${timeZone}` : query.isPending ? '时区读取中 · UTC' : timeZone}</NavigationLink>
        </header>
        <div
          id="main-content"
          className={section === 'messages' ? 'flex h-[calc(100svh-3.5rem)] min-h-0 min-w-0 flex-col gap-4 overflow-hidden p-3 md:p-6' : 'mx-auto flex w-full max-w-5xl flex-col gap-8 px-6 py-8 lg:px-10 lg:py-12'}
        >
          {notice != null && <ErrorNotice error={notice} />}
          {children ?? <>
          <div className="flex flex-col gap-3">
            <Badge variant="outline" className="w-fit">
              账号与公司基础
            </Badge>
            <h1 className="text-2xl font-semibold tracking-tight">
              公司工作区
            </h1>
            <p className="text-sm leading-6 text-muted-foreground">
              你已进入{' '}
              <span className="font-medium text-foreground">
                {company.name}
              </span>
              。你的角色是{roleLabel(company.role)}。
            </p>
          </div>
          <section
            aria-labelledby="workspace-status"
            className="rounded-xl border bg-muted/30 px-6 py-7"
          >
            <div className="flex flex-col gap-2">
              <h2 id="workspace-status" className="font-medium">
                继续准备客服知识
              </h2>
              <p className="max-w-xl text-sm leading-6 text-muted-foreground">
                消息中心、知识库和回复策略已提供管理入口。知识需完成索引和检索测试后再发布，AI 自动接待尚未开放。
              </p>
            </div>
          </section>
          <section aria-labelledby="next-steps">
            <div className="mb-2 flex items-center justify-between">
              <h2 id="next-steps" className="text-sm font-medium">
                接下来，逐步准备你的客服工作区
              </h2>
            </div>
            <ol className="divide-y">
              {[
                {
                  title: '连接店铺',
                  description:
                    '确认平台的消息、商品与订单权限，让服务有据可查。',
                  icon: Store,
                },
                {
                  title: '准备客服知识',
                  description:
                    '整理商品说明、店铺政策和常见问题，作为 AI 回答的依据。',
                  icon: BookOpen,
                },
                {
                  title: '测试并启用回复策略',
                  description: '确认回答内容和转人工条件后，再选择接待范围。',
                  icon: SlidersHorizontal,
                },
              ].map(({ title, description, icon: Icon }, index) => (
                <li key={title} className="flex items-start gap-4 py-6">
                  <span className="pt-0.5 text-xs text-muted-foreground tabular-nums">
                    0{index + 1}
                  </span>
                  <Icon
                    className="mt-0.5 hidden size-4 text-muted-foreground sm:block"
                    aria-hidden="true"
                  />
                  <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                    <h3 className="text-sm font-medium">{title}</h3>
                    <p className="text-sm leading-6 text-muted-foreground">
                      {description}
                    </p>
                  </div>
                  {title === '连接店铺' ? <Button size="sm" variant="outline" render={<NavigationLink to="/workspace/stores" />}>管理店铺</Button> : title === '准备客服知识' ? <Button size="sm" variant="outline" render={<NavigationLink to="/workspace/knowledge" />}>管理知识</Button> : <Badge variant="secondary" className="shrink-0">待开放</Badge>}
                </li>
              ))}
            </ol>
          </section>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-t pt-5 text-xs text-muted-foreground">
            <p>当前公司：{company.name}</p>
            <p className="break-all">账号：{identity.session?.user.email}</p>
          </div>
          </>}
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
