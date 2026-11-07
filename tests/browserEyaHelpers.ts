import { createBrowserTools } from '../src/main/tools/impl/browserTools';
import type { BrowserAutomationService } from '../src/main/browser/BrowserAutomationService';
import type { ToolResult } from '../src/main/tools/types';

/** What the open_website tool says when opening the page fails with this error. */
export function failureToolResult(err: Error): ToolResult | Promise<ToolResult> {
  const service = {
    openWebsite: async () => {
      throw err;
    },
  } as unknown as BrowserAutomationService;
  const tool = createBrowserTools(service).find((t) => t.schema.name === 'open_website');
  if (tool === undefined) throw new Error('no open_website tool');
  return tool.execute({ url: 'https://nope.invalid/' }) as Promise<ToolResult>;
}
