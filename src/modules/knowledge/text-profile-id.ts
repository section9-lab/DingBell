/** Stable publication identity; changing retrieval engines must not rewrite old approvals. */
export const knowledgeTextProfile = { id: 'text-grep-2400-v1' } as const;
export const readableKnowledgeProfiles = [knowledgeTextProfile.id] as const;
export type PublishedProfile = typeof readableKnowledgeProfiles[number];

type Publication = {
  status: string; tested_at: number | null; index_profile: string | null; mutation_id: string | null;
  published_profile: string | null; published_at: number | null; published_mutation_id: string | null;
};

/** Preserve the original verified vector-publication contract without trusting arbitrary profiles. */
export function isTextPublication(row: Publication): boolean {
  return row.published_at !== null && !!row.published_mutation_id
    && (row.published_profile === knowledgeTextProfile.id
      || row.status === 'ready' && row.tested_at !== null && row.index_profile !== null && !!row.mutation_id
        && row.published_at >= row.tested_at && row.published_profile === row.index_profile);
}

/** The single placeholder binds knowledgeTextProfile.id at each SQL boundary. */
export function textPublicationSQL(alias: 'rev' | 'r'): string {
  return `(${alias}.published_at IS NOT NULL AND length(${alias}.published_mutation_id)>0
    AND (${alias}.published_profile=? OR (${alias}.status='ready' AND ${alias}.tested_at IS NOT NULL
      AND ${alias}.index_profile IS NOT NULL AND length(${alias}.mutation_id)>0
      AND ${alias}.published_at>=${alias}.tested_at AND ${alias}.published_profile=${alias}.index_profile)))`;
}
