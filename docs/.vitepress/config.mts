// This config is `.mts`, not `.ts`, on purpose: the workspace root package.json
// has no `"type": "module"`, so it is CommonJS-by-default, but VitePress ships as
// ESM-only. A `.ts` config would be loaded through the CommonJS `require` path and
// fail with "vitepress resolved to an ESM file". The `.mts` extension forces the
// ESM loader for this file regardless of the root type field. Do not rename back.
import { defineConfig } from 'vitepress'

// Public product docs, deployed to GitHub Pages from the PUBLIC repo (once per
// release). This file ships as-is in that snapshot — keep it free of any
// reference to the private dev tree.
export default defineConfig({
  title: 'agent-mesh',
  description: 'Drive Claude, Codex, Antigravity, and Cursor coding agents as headless workers behind one interface.',
  base: '/agent-mesh/',
  srcExclude: ['RELEASING.md'],
  lastUpdated: true,
  sitemap: {
    hostname: 'https://toragonite.github.io/agent-mesh/',
  },
  locales: {
    root: {
      label: 'English',
      lang: 'en',
      themeConfig: {
        nav: [
          { text: 'Guide', link: '/guide/getting-started' },
          { text: 'Adapters', link: '/adapters/' },
        ],
        sidebar: [
          {
            text: 'Guide',
            items: [
              { text: 'Getting Started', link: '/guide/getting-started' },
              { text: 'Architecture', link: '/guide/architecture' },
              { text: 'Routing', link: '/guide/routing' },
            ],
          },
          {
            text: 'Adapters',
            items: [
              { text: 'Overview', link: '/adapters/' },
              { text: 'Claude Code', link: '/adapters/claude-code' },
              { text: 'Codex', link: '/adapters/codex' },
              { text: 'Antigravity (Gemini)', link: '/adapters/gemini' },
              { text: 'Cursor', link: '/adapters/cursor' },
            ],
          },
        ],
      },
    },
    ko: {
      label: '한국어',
      lang: 'ko',
      description: 'Claude, Codex, Antigravity, Cursor 코딩 에이전트를 하나의 인터페이스로 헤드리스 워커처럼 구동합니다.',
      themeConfig: {
        nav: [
          { text: '가이드', link: '/ko/guide/getting-started' },
          { text: '어댑터', link: '/ko/adapters/' },
        ],
        sidebar: [
          {
            text: '가이드',
            items: [
              { text: '시작하기', link: '/ko/guide/getting-started' },
              { text: '아키텍처', link: '/ko/guide/architecture' },
              { text: '라우팅', link: '/ko/guide/routing' },
            ],
          },
          {
            text: '어댑터',
            items: [
              { text: '개요', link: '/ko/adapters/' },
              { text: 'Claude Code', link: '/ko/adapters/claude-code' },
              { text: 'Codex', link: '/ko/adapters/codex' },
              { text: 'Antigravity (Gemini)', link: '/ko/adapters/gemini' },
              { text: 'Cursor', link: '/ko/adapters/cursor' },
            ],
          },
        ],
        outline: { level: [2, 3], label: '이 페이지의 내용' },
        docFooter: { prev: '이전 페이지', next: '다음 페이지' },
        lastUpdated: { text: '마지막 업데이트' },
        returnToTopLabel: '맨 위로',
        darkModeSwitchLabel: '다크 모드',
      },
    },
    // ja / zh: add following the `ko` block above as the docs mature.
  },
  themeConfig: {
    search: { provider: 'local' },
    socialLinks: [
      { icon: 'github', link: 'https://github.com/Toragonite/agent-mesh' },
    ],
    outline: [2, 3],
    footer: {
      message: 'Released under the MIT License. Unofficial — not affiliated with Anthropic, OpenAI, Google, or Cursor.',
      copyright: 'Copyright © 2026 Toragonite',
    },
  },
})
