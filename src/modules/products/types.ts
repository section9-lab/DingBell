export interface ProductListWork {
  kind: 'list'; storeId: string; epoch: number; generation: number; revision: number;
  cursor: string; recentCursors: string[]; dueAt: number;
}
export interface ProductDetailsWork {
  kind: 'details'; storeId: string; epoch: number; dueAt: number;
  items: { id: string; generation: number; revision: number }[];
}
export interface ProductAttributesWork {
  kind: 'attributes'; storeId: string; epoch: number; dueAt: number;
  items: { id: string }[];
}
export interface ProductDescriptionWork {
  kind: 'description'; storeId: string; epoch: number; dueAt: number;
  items: { id: string }[];
}
export type ProductWork = ProductListWork | ProductDetailsWork | ProductAttributesWork | ProductDescriptionWork;
export interface ProductCounts {
  productCount: number; readyCount: number; pendingCount: number; failedCount: number;
}
