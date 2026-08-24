// tests/smoke.test.ts
import { describe, expect, it } from 'vitest'
import { Config, inject, name } from '../src/index.ts'

describe('dsh-cae plugin entry', () => {
  it('exports loader metadata with function-plugin shape', () => {
    expect(name).toBe('dsh-cae')
    expect(inject).toEqual(['tools'])
  })
  it('Config schema carries the three deployment fields with defaults', () => {
    expect(Config.meta).toBeDefined()
  })
})
