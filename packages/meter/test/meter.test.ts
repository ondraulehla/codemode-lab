import { describe, expect, it, vi } from 'vitest'
import {
  BYTES_PER_TOKEN_ESTIMATE,
  Meter,
  estimateTokens,
  formatBytes,
  utf8Bytes,
} from '../src/index.js'

/**
 * Every headline number in this repo starts as a byte count from this module.
 * If the counting is wrong, the site is wrong, so the assertions here are exact.
 */
describe('utf8Bytes', () => {
  it('counts UTF-8 bytes, not UTF-16 code units', () => {
    // Czech diacritics are two bytes each. String.length would report 20.
    const czech = 'Příliš žluťoučký kůň'
    expect(czech.length).toBe(20)
    expect(utf8Bytes(czech)).toBe(29)

    // An emoji is one grapheme, two code units and four bytes.
    expect('😀'.length).toBe(2)
    expect(utf8Bytes('😀')).toBe(4)

    // CJK is three bytes per character, which is where a docs payload really grows.
    expect('日本語'.length).toBe(3)
    expect(utf8Bytes('日本語')).toBe(9)

    expect(utf8Bytes('ř')).toBe(2)
    expect(utf8Bytes('')).toBe(0)
    expect(utf8Bytes('plain ascii')).toBe(11)
  })

  it('agrees with an independent encoder', () => {
    // Buffer.byteLength is Node's native counter. TextEncoder is the one we ship.
    const samples = ['', 'a', 'Příliš', '😀🇨🇿', '日本語のドキュメント', 'x'.repeat(5000)]
    for (const s of samples) {
      expect(utf8Bytes(s)).toBe(Buffer.byteLength(s, 'utf8'))
    }
  })
})

describe('Meter', () => {
  const call = (over: Partial<Parameters<Meter['record']>[0]> = {}) => ({
    server: 'deepwiki',
    tool: 'read_wiki_contents',
    argsBytes: 30,
    wireBytes: 1_000,
    textBytes: 500,
    ms: 10,
    ...over,
  })

  it('assigns seq in order and never lets a caller set it', () => {
    const m = new Meter()
    const a = m.record(call())
    const b = m.record(call())
    const c = m.record({ ...call(), seq: 99 } as never)
    expect([a.seq, b.seq, c.seq]).toEqual([0, 1, 2])
    expect(m.records.map((r) => r.seq)).toEqual([0, 1, 2])
  })

  it('aggregates totals and counts only records that carry an error', () => {
    const m = new Meter()
    m.record(call({ argsBytes: 10, wireBytes: 100, textBytes: 50, ms: 5 }))
    m.record(call({ argsBytes: 20, wireBytes: 200, textBytes: 70, ms: 7, error: 'boom' }))
    m.record(call({ argsBytes: 30, wireBytes: 300, textBytes: 90, ms: 8 }))

    expect(m.totals).toEqual({
      calls: 3,
      argsBytes: 60,
      wireBytes: 600,
      textBytes: 210,
      ms: 20,
      errors: 1,
    })
  })

  it('reports zeroed totals when nothing was measured', () => {
    expect(new Meter().totals).toEqual({
      calls: 0,
      argsBytes: 0,
      wireBytes: 0,
      textBytes: 0,
      ms: 0,
      errors: 0,
    })
  })

  it('notifies listeners and stops after unsubscribe', () => {
    const m = new Meter()
    const seen = vi.fn()
    const off = m.onRecord(seen)

    m.record(call())
    expect(seen).toHaveBeenCalledTimes(1)
    expect(seen.mock.calls[0][0].seq).toBe(0)

    off()
    m.record(call())
    expect(seen).toHaveBeenCalledTimes(1)
    expect(m.records).toHaveLength(2)
  })

  it('gives every listener the same record object it stored', () => {
    const m = new Meter()
    const seen: unknown[] = []
    m.onRecord((r) => seen.push(r))
    m.onRecord((r) => seen.push(r))
    const rec = m.record(call())
    expect(seen).toEqual([rec, rec])
    expect(m.records[0]).toBe(rec)
  })

  it('reset clears records and restarts seq', () => {
    const m = new Meter()
    m.record(call())
    m.record(call())
    m.reset()
    expect(m.records).toHaveLength(0)
    expect(m.record(call()).seq).toBe(0)
  })
})

describe('estimates and formatting', () => {
  it('estimateTokens divides by the documented ratio', () => {
    expect(BYTES_PER_TOKEN_ESTIMATE).toBe(3.8)
    expect(estimateTokens(3800)).toBe(1000)
    expect(estimateTokens(0)).toBe(0)
    // 728.2 kB of DeepWiki text, the measured apify/apify-mcp-server payload.
    expect(estimateTokens(728_200)).toBe(191_632)
  })

  it('formatBytes switches unit at the right boundaries', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1023)).toBe('1023 B')
    expect(formatBytes(1024)).toBe('1.0 kB')
    expect(formatBytes(1_048_575)).toBe('1024.0 kB')
    expect(formatBytes(1_048_576)).toBe('1.00 MB')
    expect(formatBytes(1_550_347)).toBe('1.48 MB')
  })
})
