import { Bash } from 'just-bash/browser';
import type { KnowledgeVirtualFile } from './virtual-files.ts';

const MAX_COMMAND_BYTES = 4 * 1024;
const MAX_OUTPUT_BYTES = 16 * 1024;
const MAX_FILES = 500;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

/**
 * Discovery only. A fresh in-memory filesystem is created for every invocation.
 * Shell output is untrusted and is never evidence or permission to send a reply.
 * Callers must authorize the run and snapshot before and after the invocation.
 */
export async function runKnowledgeDiscovery(files: readonly KnowledgeVirtualFile[], command: string, signal?: AbortSignal) {
  if (typeof command !== 'string' || !command.trim() || new TextEncoder().encode(command).length > MAX_COMMAND_BYTES) {
    throw new RangeError('INVALID_KNOWLEDGE_COMMAND');
  }
  if (files.length > MAX_FILES) throw new Error('KNOWLEDGE_DIRECTORY_TOO_LARGE');
  const initial: Record<string, string> = Object.create(null) as Record<string, string>;
  let bytes = 0;
  const encoder = new TextEncoder();
  for (const file of files) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(file.documentId)
      || file.path !== `/knowledge/${file.documentId}.md` || Object.hasOwn(initial, file.path)) throw new Error('INVALID_KNOWLEDGE_FILE');
    bytes += encoder.encode(file.content).length;
    if (bytes > MAX_FILE_BYTES) throw new Error('KNOWLEDGE_DIRECTORY_TOO_LARGE');
    initial[file.path] = file.content;
  }
  signal?.throwIfAborted();
  const shell = new Bash({
    files: initial, cwd: '/knowledge',
    commands: ['grep', 'cat', 'ls', 'head', 'tail', 'wc'],
    executionLimitProfile: 'hardened',
    executionLimits: { maxExecutionTimeMs: 2_000, maxCommandCount: 100, maxOutputSize: MAX_OUTPUT_BYTES, maxFileSystemBytes: 4 * 1024 * 1024 },
  });
  const result = await shell.exec(command, { signal });
  signal?.throwIfAborted();
  return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode, canSend: false as const };
}
