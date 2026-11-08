import { Bash } from 'just-bash/browser';
import { runKnowledgeDiscovery } from '../../src/modules/knowledge/virtual-bash.ts';

// Synthetic data only. This probe does not connect to the application database.
export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.searchParams.has('applicationCore')) {
      const id = '00000001-0000-4000-8000-000000000000';
      return Response.json(await runKnowledgeDiscovery([{
        documentId: id, path: `/knowledge/${id}.md`, revision: 1,
        contentHash: 'a'.repeat(64), title: 'FAQ', content: 'FAQ\n退货政策：需要人工确认\n',
      }], "grep -n -F '退货' /knowledge/*.md"));
    }
    const query = url.searchParams.get('query') ?? '退货';
    const shell = new Bash({
      files: {
        '/knowledge/faq.txt': 'FAQ\n退货政策：需要人工确认\nВОЗВРАТ товара\n$(echo injected)\n',
      },
      executionLimitProfile: 'hardened',
      executionLimits: { maxCommandCount: 20, maxOutputSize: 4096, maxExecutionTimeMs: 1000 },
    });
    // Arguments are passed separately; the query is never interpolated into shell source.
    const result = await shell.exec('grep', { args: ['-n', '-F', '--', query, '/knowledge/faq.txt'] });
    if (new URL(request.url).searchParams.has('probeReadonly')) {
      // InMemoryFs permissions are metadata, not a read-only security boundary.
      await shell.exec('chmod 444 /knowledge/faq.txt');
      const write = await shell.exec('echo modified > /knowledge/faq.txt');
      const read = await shell.exec('cat /knowledge/faq.txt');
      return Response.json({ writeExitCode: write.exitCode, stdout: read.stdout });
    }
    return Response.json({ stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode });
  },
};
