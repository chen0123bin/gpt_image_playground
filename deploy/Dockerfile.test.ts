import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('deploy Dockerfile', () => {
  it('生产阶段复制 package.json 以保留 Node ESM 语义', async () => {
    const dockerfile = await readFile(new URL('./Dockerfile', import.meta.url), 'utf8')

    expect(dockerfile).toContain('COPY --from=build /app/package.json ./package.json')
  })
})
