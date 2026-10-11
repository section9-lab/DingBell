export interface ProductListWork {
  kind: 'list'; storeId: string; epoch: number; generation: number; revision: number;
  cursor: string; recentCursors: string[]; dueAt: number;
}
export interface ProductDetailsWork {
  kind: 'details'; storeId: string; epoch: number; dueAt: number;
  items: { id: string; generation: number; revision: number }[];
}
export type ProductWork = ProductListWork | ProductDetailsWork;
export interface ProductCounts {
  productCount: number; readyCount: number; pendingCount: number; failedCount: number;
}
