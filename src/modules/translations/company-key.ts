import * as v from 'valibot';
import { openModelKey, type CompanyModelBindings } from '../company-model/security.ts';
import type { TranslationBindings } from './bindings.ts';

/** 翻译端点固定在 NVIDIA；只有公司连接指向同一端点时才允许复用它的密钥。 */
export const translationBaseUrl = 'https://integrate.api.nvidia.com/v1';
const rowSchema = v.object({ revision: v.number(), baseUrl: v.string(), model: v.string(),
  keyVersion: v.string(), nonce: v.string(), ciphertext: v.string() });

/**
 * 部署级 NVAPI_KEY 存在时优先使用；否则复用「公司设置 > AI 模型」里已保存的
 * NVIDIA 连接，避免为了翻译再让用户配一份同样的密钥。连接指向其他服务时返回 null，
 * 不能把一个平台的凭证发给另一个端点。
 */
export async function translationApiKey(env: TranslationBindings, organizationId: string): Promise<string | null> {
  const configured = typeof env.NVAPI_KEY === 'string' ? env.NVAPI_KEY.trim() : '';
  if (configured) return configured;
  if (!env.DB) return null;
  let raw: unknown;
  try {
    raw = await env.DB.prepare(`SELECT revision,base_url AS baseUrl,model,key_version AS keyVersion,nonce,ciphertext
      FROM company_ai_model_revision WHERE organization_id=? ORDER BY revision DESC LIMIT 1`).bind(organizationId).first();
  } catch { return null; }
  const parsed = v.safeParse(rowSchema, raw);
  if (!parsed.success || parsed.output.baseUrl !== translationBaseUrl) return null;
  try {
    return await openModelKey(env as unknown as CompanyModelBindings, organizationId, parsed.output.revision,
      parsed.output.baseUrl, parsed.output.model, parsed.output);
  } catch { return null; }
}
