import fs from 'node:fs'
import { defineConfig } from 'vitest/config'

// Workspace runner: every member that carries tests is a project. The two liquidation bots hold
// their own vitest.config.ts (soltag `sol``` transform + fork-suite env files); the rest run with
// defaults rooted at their own directory. The public mirror ships a subset of these members, so
// absent ones are dropped rather than failing the run.
const members = [
  'packages/utils',
  'packages/bot-kit',
  'packages/ci-scripts',
  'packages/swaps',
  'packages/logging',
  'packages/monitoring',
  'packages/observability',
  'packages/offers',
  'packages/telemetry',
  'bots/blue-liquidation',
  'bots/vault-v1-reallocation',
  'bots/vault-v2-reallocation',
  'bots/midnight-liquidation',
  'bots/midnight-crossed-books',
  'bots/quoter-bot'
].filter(member => fs.existsSync(new URL(`${member}/package.json`, import.meta.url)))

export default defineConfig({
  test: {
    projects: [
      // Workspace-wide invariants that belong to no single member (dependency deduplication).
      { test: { name: 'workspace', root: import.meta.dirname, include: ['test/**/*.test.ts'] } },
      ...members
    ]
  }
})
