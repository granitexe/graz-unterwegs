import { afterEach, describe, expect, it, vi } from 'vitest'
import { searchPlaces } from './transitous'


afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const result = [{ type: 'STOP', name: 'Cache test stop', id: 'cache-test-stop', lat: 47.07, lon: 15.44 }]
const response = () => new Response(JSON.stringify(result), { status: 200 })

describe('Transitous request sharing', () => {
  it('shares a request without letting one caller cancel another', async () => {
    let complete!: (value: Response) => void
    const fetchMock = vi.fn(() => new Promise<Response>(resolve => { complete = resolve }))
    vi.stubGlobal('fetch', fetchMock)
    const first = new AbortController()
    const second = new AbortController()
    const abandoned = searchPlaces('Shared stop test', 'STOP', 'en', first.signal)
    const retained = searchPlaces('Shared stop test', 'STOP', 'en', second.signal)
    first.abort()
    await expect(abandoned).rejects.toBeDefined()
    complete(response())
    await expect(retained).resolves.toMatchObject({ choices: [{ name: 'Cache test stop' }], incomplete: false })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('expires geocoding results after ten minutes', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn(async () => response())
    vi.stubGlobal('fetch', fetchMock)
    const search = () => searchPlaces('Expiry stop test', 'STOP', 'en', new AbortController().signal)
    await search()
    await search()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(600_000)
    await search()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

describe('unified place search', () => {
  it('merges provider results, ranks exact house numbers, and caches subtypes', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const params = new URL(String(url)).searchParams
      expect(params.get('place')).toBe('47.0707,15.4395')
      expect(params.get('min')).toBe('47.01099856381888,15.349171800035792')
      expect(params.get('max')).toBe('47.135508816624096,15.535504642151956')
      expect(params.get('numResults')).toBe('20')
      expect(params.get('language')).toBe('de')
      const stop = params.get('type') === 'STOP'
      expect(params.get('text')).toBe(stop ? 'korosistrasse 48' : 'korosistrasse 48, Graz')
      return new Response(JSON.stringify(stop ? [
        { type: 'STOP', id: 'platform-a', name: 'Körösistraße', lat: 47.07, lon: 15.44 },
        { type: 'STOP', id: 'platform-b', name: 'Körösistraße', lat: 47.07, lon: 15.44 },
        { type: 'STOP', id: 'platform-a', name: 'Körösistraße', lat: 47.07, lon: 15.44 },
      ] : [
        { type: 'ADDRESS', id: '', name: 'Körösistraße 48a', street: 'Körösistraße', houseNumber: '48a', lat: 47.071, lon: 15.44 },
        { type: 'ADDRESS', id: '', name: 'Körösistraße', street: 'Körösistraße', lat: 47.072, lon: 15.44 },
        { type: 'ADDRESS', id: '', name: 'Körösistraße 48b', street: 'Körösistraße', houseNumber: '48b', lat: 47.071, lon: 15.44 },
        { type: 'ADDRESS', id: '', name: 'Körösistraße 48', street: 'Körösistraße', houseNumber: '48', lat: 47.073, lon: 15.44 },
        { type: 'ADDRESS', id: '', name: 'Körösistraße 48', street: 'Körösistraße', houseNumber: '48', lat: 47.073, lon: 15.44 },
        { type: 'ADDRESS', id: '', name: 'Outside', lat: 48, lon: 16 },
        { type: 'ADDRESS', name: 'Invalid', lat: 'bad', lon: 15.44 },
      ]))
    })
    vi.stubGlobal('fetch', fetchMock)
    const signal = new AbortController().signal
    const result = await searchPlaces('korosistrasse 48', 'ALL', 'de', signal)
    expect(result.incomplete).toBe(false)
    expect(result.choices.map(choice => choice.name)).toEqual(['Körösistraße 48', 'Körösistraße', 'Körösistraße 48a', 'Körösistraße', 'Körösistraße', 'Körösistraße 48b'])
    expect(result.choices.filter(choice => choice.kind === 'STOP').map(choice => choice.stopId)).toEqual(['platform-a', 'platform-b'])
    expect(result.choices.find(choice => choice.kind === 'ADDRESS' && choice.name === 'Körösistraße')?.houseNumber).toBeUndefined()
    await searchPlaces('korosistrasse 48', 'ADDRESS', 'de', signal)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('returns partial results without caching failures', async () => {
    let failed = true
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const kind = new URL(String(url)).searchParams.get('type')
      if (kind === 'ADDRESS' && failed) return new Response('', { status: 503 })
      return new Response(JSON.stringify(kind === 'STOP' ? result : []))
    })
    vi.stubGlobal('fetch', fetchMock)
    const signal = new AbortController().signal
    await expect(searchPlaces('Partial provider test', 'ALL', 'en', signal)).resolves.toMatchObject({ incomplete: true, choices: [{ name: 'Cache test stop' }] })
    failed = false
    await expect(searchPlaces('Partial provider test', 'ALL', 'en', signal)).resolves.toMatchObject({ incomplete: false })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('reports the longest retry delay when both branches fail', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => new Response('', {
      status: 429, headers: { 'Retry-After': new URL(String(url)).searchParams.get('type') === 'STOP' ? '3' : '9' },
    })))
    await expect(searchPlaces('Rate limit both', 'ALL', 'en', new AbortController().signal)).rejects.toMatchObject({ kind: 'rate-limited', retryAfterMs: 9000 })
  })

  it('distinguishes outside results from a successful empty result', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => new Response(JSON.stringify(
      new URL(String(url)).searchParams.get('text')?.includes('Outside boundary')
        ? [{ type: 'STOP', id: 'outside', name: 'Outside', lat: 48, lon: 16 }]
        : [],
    ))))
    const signal = new AbortController().signal
    await expect(searchPlaces('Outside boundary', 'STOP', 'en', signal)).rejects.toMatchObject({ kind: 'out-of-area' })
    await expect(searchPlaces('Empty boundary', 'STOP', 'en', signal)).resolves.toEqual({ choices: [], incomplete: false })
  })

  it('aborts both branches and does not cache aborted requests', async () => {
    const signals: AbortSignal[] = []
    const fetchMock = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      const signal = init!.signal as AbortSignal
      signals.push(signal)
      return new Promise<Response>((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))))
    })
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    const pending = searchPlaces('Abort both branches', 'ALL', 'en', controller.signal)
    controller.abort()
    await expect(pending).rejects.toBeDefined()
    expect(signals).toHaveLength(2)
    expect(signals.every(signal => signal.aborted)).toBe(true)
    const retry = vi.fn(async () => new Response('[]'))
    vi.stubGlobal('fetch', retry)
    await expect(searchPlaces('Abort both branches', 'ALL', 'en', new AbortController().signal)).resolves.toEqual({ choices: [], incomplete: false })
    expect(retry).toHaveBeenCalledTimes(2)
  })
})
