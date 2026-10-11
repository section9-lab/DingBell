import * as v from 'valibot';

const userSchema = v.object({
  id: v.string(),
  name: v.string(),
  email: v.string(),
  emailVerified: v.boolean(),
  image: v.nullable(v.string()),
});
const setupSchema = v.object({
  identity: v.object({ configured: v.boolean() }),
  registration: v.object({ enabled: v.boolean() }),
  email: v.object({ configured: v.boolean() }),
});
const sessionSchema = v.nullable(
  v.object({
    user: userSchema,
    session: v.object({
      id: v.string(),
      expiresAt: v.string(),
      activeOrganizationId: v.nullable(v.string()),
    }),
  }),
);
const companySchema = v.object({
  id: v.string(),
  name: v.string(),
  slug: v.string(),
  role: v.string(),
});
const companiesSchema = v.object({
  companies: v.array(companySchema),
  activeCompanyId: v.nullable(v.string()),
});
const errorSchema = v.object({
  error: v.object({ code: v.string(), row: v.optional(v.nullable(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(20)))) }),
  requestId: v.optional(v.string()),
});

export type Company = v.InferOutput<typeof companySchema>;
export type Identity = Awaited<ReturnType<typeof readIdentity>>;

const messages: Record<string, string> = {
  AI_DRAFT_UNAVAILABLE: '暂时无法核对 AI 草稿。请刷新后再采纳，当前输入不会改变。',
  REPLY_TEST_DISABLED: 'AI 回复测试尚未启用，请联系部署管理员配置模型和预算。',
  AI_DISABLED: 'AI 接待尚未启用，请联系部署管理员。',
  AI_NOT_CONFIGURED: 'AI 接待的模型、价格或运行服务尚未配置，请联系部署管理员。',
  AI_BUDGET_UNAVAILABLE: '当前没有足够的 AI 接待预算或次数，请联系公司管理员。',
  AI_RECEPTION_UNAVAILABLE: '暂时不能恢复 AI。请核对已发布策略与店铺状态；上一次接待尚未结束时，需要等待关闭。',
  RESUMPTION_NOT_FOUND: '暂未查到原恢复操作的结果，请保留原操作并继续核对。',
  REPLY_TEST_UNAVAILABLE: 'AI 回复测试服务暂不可用，请读取已保存的测试记录后再操作。',
  REPLY_TEST_QUERY_LIMIT: '今日问答检索额度已用完，请在 UTC 日期更新后新建测试。',
  REPLY_TEST_CONFLICT: '此编号已属于另一个测试，请读取原测试记录。',
  REPLY_TEST_CHANGED: '会话、策略或知识已变化，请核对最新内容后新建测试。',
  PRICING_UNAVAILABLE: '模型价格或运行配置尚未确认，请联系部署管理员。',
  BUDGET_UNAVAILABLE: '模型预算未启用、已到期或余额不足，请联系公司管理员。',
  BUDGET_CHANGED: '预算已被修改，请读取当前状态后再决定是否操作。',
  BUDGET_COMMAND_CONFLICT: '此操作编号已用于其他预算变更，请读取原管理记录。',
  BUDGET_WINDOW_OVERLAP: '此时间段与已有预算重叠，暂停中的预算也占用原时间窗。请核对后选择其他日期。',
  BUDGET_WINDOW_EXPIRED: '新预算须从今天或未来的 UTC 日期开始，结束日期须在未来；已到期预算不能重新启用。',
  KNOWLEDGE_FILE_INVALID: '文件或导入范围不正确，请重新选择。',
  KNOWLEDGE_FILE_TOO_LARGE: '文件超过 64 KiB，请拆分后重新导入。',
  KNOWLEDGE_FILE_UNSUPPORTED: '目前支持 TXT、Markdown 和 CSV，PDF、扫描件及其他格式暂不支持。',
  KNOWLEDGE_FILE_TYPE: '文件类型与内容不匹配，请上传文本文件。',
  KNOWLEDGE_FILE_ENCODING: '无法读取文件编码，请另存为 UTF-8 后重试。',
  KNOWLEDGE_FILE_CONTENT: '标题或正文为空、包含无效字符或超过单条大小限制，请修改后重试。',
  KNOWLEDGE_FILE_CSV: 'CSV 格式不正确。请使用 title,content 表头，并检查引号与列数。',
  KNOWLEDGE_FILE_ROWS: 'CSV 最多包含 20 条知识，请拆分文件后重试。',
  KNOWLEDGE_FILE_DUPLICATE: 'CSV 存在相同标题和正文的重复记录，请去重后重试。',
  KNOWLEDGE_FILE_CONFLICT: '目标知识与导入内容不一致，请联系管理员核对。',
  KNOWLEDGE_FILE_CHANGED: '文件或适用范围已变化，请重新预览后确认。',
  KNOWLEDGE_FILE_PREVIEW_FAILED: '未能完成文件预览，请重新预览。此次操作没有保存知识。',
  PRODUCT_SOURCE_CHANGED: '商品来源已更新，请刷新预览并重新核对。',
  PRODUCT_SOURCE_UNAVAILABLE: '商品资料尚未同步完整、已归档或超出支持范围，请核对来源后再导入。',
  INVALID_CREDENTIALS: '邮箱或密码不正确，请重新输入。',
  AUTHENTICATION_REJECTED: '暂时无法登录，请确认账号已完成邮箱验证。',
  UNAUTHENTICATED: '登录已失效，请重新登录。',
  RATE_LIMITED: '尝试次数较多，请稍后再试。',
  ORIGIN_REJECTED: '当前访问地址与配置不一致，请联系部署管理员。',
  IDENTITY_NOT_CONFIGURED: '登录服务尚未配置，请联系部署管理员。',
  AUDIT_UNAVAILABLE: '操作记录暂时无法保存，本次操作未执行，请稍后重试。',
  OPERATION_UNCONFIRMED:
    '操作结果暂未确认，已重新读取账号状态。请确认当前状态后再操作。',
  NOT_FOUND: '此内容不可访问。请确认登录邮箱正确，或联系公司管理员检查权限。',
  POLICY_CHANGED: '策略已被修改，请读取最新版本并核对后再操作。',
  KNOWLEDGE_CHANGED: '知识版本已变化，请读取最新版本并核对后再操作。',
  KNOWLEDGE_INDEXING_UNAVAILABLE: '索引服务尚未启用。可先保存草稿，请联系部署管理员配置索引。',
  KNOWLEDGE_REVIEW_UNAVAILABLE: '检索测试与发布服务尚未启用，请联系部署管理员。',
  KNOWLEDGE_INDEX_LIMIT: '今日索引额度已用完，请在 UTC 日期更新后重试。',
  KNOWLEDGE_REVIEW_LIMIT: '今日检索测试或发布额度已用完，请在 UTC 日期更新后重试。',
  POLICY_TEST_REQUIRED: '请先检查已保存的草稿，再发布策略。',
  POLICY_OVERLAP: '同一店铺和业务阶段已有相同优先级的自动回复策略，请调整范围或优先级。',
  POLICY_STORE_UNAVAILABLE: '策略中的店铺已不可用，请重新选择店铺并保存草稿。',
  INVALID_REQUEST: '填写的信息不完整或格式不正确，请检查后重试。',
  MAIL_NOT_CONFIGURED: '邮件服务尚未配置，请联系部署管理员。',
  MAIL_DELIVERY_FAILED: '邮件服务暂未确认接收，请稍后重试。',
  INVALID_LINK: '邮件链接无效或已过期，请申请一封新邮件。',
  BOOTSTRAP_NOT_CONFIGURED: '首次安装配置尚未完成，请联系部署管理员。',
  BOOTSTRAP_UNAUTHORIZED: '安装令牌不正确，请向部署管理员确认。',
  BOOTSTRAP_ALREADY_CLAIMED: '已有安装任务，请重新读取进度并继续。',
  BOOTSTRAP_ALREADY_POPULATED: '已有账号或公司数据，不能通过首次安装提升权限。请联系部署管理员。',
  BOOTSTRAP_CLOSED: '安装已完成，请使用已有账号登录。',
  BOOTSTRAP_BUSY: '同一个安装任务正在执行，请稍后重新读取进度。',
  BOOTSTRAP_BLOCKED: '安装数据与保存的任务不一致，请联系部署管理员检查。',
  BOOTSTRAP_CONFLICT: '安装记录发生冲突，请重新读取进度；若仍无法继续，请联系部署管理员。',
  BOOTSTRAP_STEP_UNCONFIRMED: '上一步结果尚未确认，请读取保存的安装进度，再继续同一个安装任务。',
  INVITATION_EXPIRED: '邀请已过期，请联系邀请人发送新邀请。',
  INVITATION_REVOKED: '邀请已被撤销，请联系邀请人确认。',
  MEMBERSHIP_REMOVED: '你的公司成员资格已被移除，旧邀请不能恢复权限。',
  MEMBER_CHANGED: '该成员的角色已经变化，请确认最新状态后再操作。',
  LAST_OWNER_REQUIRED: '公司必须保留至少一名所有者。请先为另一名成员授予所有者权限。',
  PASSWORD_CONFIRMATION_REQUIRED: '涉及所有者权限，请输入你自己的当前密码确认。',
  INVALID_PASSWORD: '当前密码不正确，请重新输入你自己的密码。',
  CREDENTIALS_NOT_CONFIGURED: '店铺凭证加密尚未配置，请联系部署管理员。',
  CREDENTIALS_UNAVAILABLE: '当前店铺凭证无法使用，请联系管理员检查加密配置或更新凭证。',
  STORE_CREDENTIALS_REQUIRED: '店铺尚未保存凭证，请先更新 API Key。',
  STORE_PAUSED: '店铺已暂停，请恢复连接后再检查。',
  STORE_EXISTS: '此店铺已添加，请返回列表确认，勿重复添加。',
  STORE_CHANGED: '店铺状态已变化，请确认最新状态后再操作。',
  STORE_BUSY: '店铺检查仍在进行，请稍后刷新状态。',
  SYNC_NOT_CONFIGURED: '同步服务尚未配置，请联系部署管理员。',
  SYNC_CAPABILITY_REQUIRED: '请先检查当前凭证和聊天列表读取权限，再启用同步。',
  PRODUCT_SYNC_CAPABILITY_REQUIRED: '请先检查当前凭证和商品读取权限，再启用商品同步。',
  FBS_SYNC_CAPABILITY_REQUIRED: '请先检查当前凭证和 FBS 包裹列表读取权限，再启用包裹同步。',
  SYNC_CHANGED: '同步状态或店铺权限已变化，请确认最新状态后再操作。',
  CONTROL_NOT_CONFIGURED: '会话处理服务尚未配置，请联系部署管理员。',
  CONTROL_UNAVAILABLE: '暂时无法读取会话处理状态，请重试。',
  CONVERSATION_CHANGED: '会话状态已变化，请刷新确认后再操作。',
  TRANSFER_TARGET_UNAVAILABLE: '该成员当前无法接手此会话，请重新选择。',
  COMMAND_CONFLICT: '操作记录发生冲突，请重新读取会话状态后再操作。',
  OUTBOUND_DISABLED: '当前部署或店铺尚未开启对外回复。',
  CAPABILITY_UNVERIFIED: '尚未确认店铺的回复权限，请联系管理员核实。',
  REPLY_UNAVAILABLE: '当前会话或店铺暂不满足发送条件，请刷新状态后确认。',
  PREVIEW_UNAVAILABLE: '原翻译预览不可用于本次回复，请核对原文并重新生成预览。',
  REPLY_NOT_CANCELABLE: '这条回复已开始发送或已结束，无法取消。请刷新发送结果。',
  CHECK_RATE_LIMITED: '检查过于频繁，请稍后再试。',
  GRANT_CHANGED: '成员或店铺授权已变化，请重新读取权限后再操作。',
  ACCOUNT_EXISTS: '此邮箱已有账号，请登录后接受邀请；忘记密码可通过邮件找回。',
  INVITATION_ALREADY_PENDING: '该邮箱已有待接受的邀请，请使用列表中的重发按钮。',
  INVITATION_IN_PROGRESS: '邀请正在处理，请稍后重新检查状态。',
  INVITATION_ACCEPTED: '邀请已经接受，不能再重发或撤销。',
  INVITATION_INVALID: '此邀请当前不可用，请联系邀请人确认。',
  INVITATION_UNCONFIRMED: '旧邀请缺少完整的处理记录，请联系管理员重新发出邀请。',
  FORBIDDEN: '你没有执行此操作的权限，请联系公司所有者。',
  INVALID_RESPONSE: '服务返回了无法识别的数据，请重新加载。',
  NETWORK_ERROR: '连接服务失败，请检查网络后重试。',
};

export class ApiError extends Error {
  code: string;
  requestId?: string;
  constructor(code: string, requestId?: string, row?: number | null) {
    super((row && code.startsWith('KNOWLEDGE_FILE_') ? `第 ${row} 条：` : '') + (messages[code] ?? '服务暂时不可用，请稍后重试。'));
    this.code = code;
    this.requestId = requestId;
  }
}

export async function request<
  S extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>,
>(path: string, schema: S, init: RequestInit = {}): Promise<v.InferOutput<S>> {
  const writing = init.method === 'POST';
  const headers = new Headers(init.headers);
  if (writing && !(init.body instanceof FormData)) headers.set('content-type', 'application/json');
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.any([
        AbortSignal.timeout(15_000),
        ...(init.signal ? [init.signal] : []),
      ]),
      headers,
    });
  } catch {
    throw new ApiError(writing ? 'OPERATION_UNCONFIRMED' : 'NETWORK_ERROR');
  }
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const parsed = v.safeParse(errorSchema, data);
    throw new ApiError(
      parsed.success
        ? parsed.output.error.code
        : writing && response.status >= 500
          ? 'OPERATION_UNCONFIRMED'
          : 'IDENTITY_UNAVAILABLE',
      parsed.success ? parsed.output.requestId : undefined,
      parsed.success ? parsed.output.error.row : undefined,
    );
  }
  const parsed = v.safeParse(schema, data);
  if (!parsed.success)
    throw new ApiError(writing ? 'OPERATION_UNCONFIRMED' : 'INVALID_RESPONSE');
  return parsed.output;
}

export async function readIdentity(signal?: AbortSignal) {
  const setup = await request('/api/setup', setupSchema, { signal });
  if (!setup.identity.configured)
    return { setup, session: null, companies: null };
  try {
    const session = await request('/api/auth/get-session', sessionSchema, {
      signal,
    });
    if (!session) return { setup, session: null, companies: null };
    const companies = await request('/api/companies', companiesSchema, {
      signal,
    });
    return { setup, session, companies };
  } catch (error) {
    if (error instanceof ApiError && error.code === 'UNAUTHENTICATED')
      return { setup, session: null, companies: null };
    throw error;
  }
}

export function signIn(email: string, password: string) {
  return request(
    '/api/auth/sign-in/email',
    v.object({ user: userSchema, redirect: v.boolean() }),
    { method: 'POST', body: JSON.stringify({ email, password }) },
  );
}

export function activateCompany(id: string) {
  return request(
    `/api/companies/${encodeURIComponent(id)}/activate`,
    v.object({ activeCompanyId: v.string() }),
    { method: 'POST', body: '{}' },
  );
}

export function signOut() {
  return request('/api/auth/sign-out', v.object({ success: v.literal(true) }), {
    method: 'POST',
    body: '{}',
  });
}
