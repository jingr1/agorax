import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchSkillFromUrl } from './import-from-url'

const dns = vi.hoisted(() => ({
  lookup: vi.fn(async () => [{ address: '8.8.8.8', family: 4 }]),
}))
vi.mock('node:dns/promises', () => ({ ...dns, default: dns }))

afterEach(() => {
  vi.unstubAllGlobals()
  dns.lookup.mockReset().mockResolvedValue([{ address: '8.8.8.8', family: 4 }])
})

describe('complete GitHub skill import', () => {
  it('pins downloads to a commit and preserves nested files, bytes and executability', async () => {
    const binary = new Uint8Array([0, 255, 128, 10])
    const fetch = vi.fn(async (url: string) => {
      if (url.endsWith('/commits/main'))
        return new Response(JSON.stringify({ sha: 'commit-hash' }))
      if (url.includes('/git/trees/commit-hash'))
        return new Response(
          JSON.stringify({
            sha: 'tree-not-commit',
            tree: [
              { path: 'example/SKILL.md', type: 'blob', mode: '100644' },
              { path: 'example/scripts/run.sh', type: 'blob', mode: '100755' },
              {
                path: 'example/references/guide.md',
                type: 'blob',
                mode: '100644',
              },
              {
                path: 'example/assets/picture.png',
                type: 'blob',
                mode: '100644',
              },
            ],
          }),
        )
      expect(url).toContain('/commit-hash/example/')
      if (url.endsWith('SKILL.md'))
        return new Response('---\nname: complete\n---\nUse scripts/run.sh')
      if (url.endsWith('run.sh')) return new Response('echo hello')
      if (url.endsWith('guide.md')) return new Response('# Guide')
      return new Response(binary)
    })
    vi.stubGlobal('fetch', fetch)
    const { bundle } = await fetchSkillFromUrl(
      'https://github.com/owner/repo/tree/main/example',
    )
    expect(bundle.resolvedCommit).toBe('commit-hash')
    expect(
      bundle.files.find((file) => file.path === 'scripts/run.sh')?.executable,
    ).toBe(true)
    expect(
      bundle.files.find((file) => file.path === 'references/guide.md')?.content,
    ).toBe('# Guide')
    expect(
      bundle.files.find((file) => file.path === 'assets/picture.png'),
    ).toMatchObject({
      encoding: 'base64',
      content: Buffer.from(binary).toString('base64'),
    })
  })

  it('refuses private destinations before making a request', async () => {
    dns.lookup.mockResolvedValue([{ address: '127.0.0.1', family: 4 }])
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    await expect(
      fetchSkillFromUrl('https://example.test/SKILL.md'),
    ).rejects.toThrow(/Private network/)
    expect(fetch).not.toHaveBeenCalled()
  })
})
