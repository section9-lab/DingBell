// Test fixtures replace this module at build time; production has no alternate URL or transport binding.
export const sendPreviewRequest:typeof fetch=(input,init)=>fetch(input,init);
