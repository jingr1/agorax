// Server-side compatibility re-export. The pure implementation lives in the
// client-safe module `src/lib/managed-agent-runtime/prompt-content.ts` so both
// browser code and server runtime share one source of truth.
export {
  managedPromptContentFromAttachments,
  type AgoraxManagedImageMimeType,
  type AgoraxManagedPromptContentBlock,
} from '@/lib/managed-agent-runtime/prompt-content'
