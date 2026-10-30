/** Node artifacts do not contain Flue. Old platform receipts remain unconfirmed until explicitly migrated. */
function unavailable(): never { throw new Error('LEGACY_EXECUTION_REQUIRES_ORIGINAL_PLATFORM'); }
export const createTranslationRuntime = unavailable;
export const createReplyTestRuntime = unavailable;
export const createSupportRuntime = unavailable;
export const dispatchSupport = unavailable;
