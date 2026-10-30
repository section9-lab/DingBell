/** This application installs only business tools. Disable the SDK's optional virtual-shell capability. */
export class InMemoryFs { constructor() { throw new Error('CODING_TOOLS_DISABLED'); } }
export class Bash { constructor() { throw new Error('CODING_TOOLS_DISABLED'); } }
