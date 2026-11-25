const EMAIL_ADDRESS = /[A-Z0-9._%+\-[\]]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi
const LOCAL_PATH = /(^|[\s"'`([{=:])((?:\/(?:Users|home)\/[^\s"'`<>,;]+|\/root(?:\/[^\s"'`<>,;]+)*|[A-Z]:[\\/]+Users[\\/]+[^\s"'`<>,;]+))/gim
const URL_TOKEN = /(?:https?|wss?|file):\/\/[^\s"'`<>]+/gi

function redactPrivateText(value: string): string {
  const publicUrls: string[] = []
  let publicUrlTokenPrefix = '\uE000'
  while (value.includes(publicUrlTokenPrefix)) publicUrlTokenPrefix += '\uE000'
  const withProtectedUrls = value
    .replace(EMAIL_ADDRESS, '[redacted-email]')
    .replace(URL_TOKEN, (candidate) => {
      try {
        const url = new URL(candidate)
        const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.+$/, '').toLowerCase()
        const loopbackIpv4 = hostname.split('.').length === 4 && hostname.split('.').every((part) => /^\d+$/.test(part)) && Number(hostname.split('.')[0]) === 127
        const mappedIpv4 = hostname.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
        const loopbackMappedIpv4 = mappedIpv4
          ? ((Number.parseInt(mappedIpv4[1]!, 16) * 0x10000 + Number.parseInt(mappedIpv4[2]!, 16)) >>> 24) === 127
          : false
        if (url.protocol === 'file:' || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '::1' || loopbackIpv4 || loopbackMappedIpv4) {
          return '[redacted-local-url]'
        }
        const token = `${publicUrlTokenPrefix}${publicUrls.length}\uE001`
        publicUrls.push(candidate)
        return token
      } catch {
        return candidate
      }
    })
  let redacted = withProtectedUrls
    .replace(LOCAL_PATH, (_match, prefix: string) => `${prefix}[redacted-local-path]`)
  for (const [index, publicUrl] of publicUrls.entries()) {
    redacted = redacted.split(`${publicUrlTokenPrefix}${index}\uE001`).join(publicUrl)
  }
  return redacted
}

export function redactPrivateData<T>(value: T): T {
  if (typeof value === 'string') return redactPrivateText(value) as T
  if (Array.isArray(value)) return value.map(redactPrivateData) as T
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactPrivateData(entry)])) as T
  }
  return value
}

export function containsPrivateData(value: unknown): boolean {
  if (typeof value === 'string') return redactPrivateText(value) !== value
  if (Array.isArray(value)) return value.some(containsPrivateData)
  if (value && typeof value === 'object') return Object.values(value).some(containsPrivateData)
  return false
}
