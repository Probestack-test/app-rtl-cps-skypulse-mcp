/** Small in-process counters, rendered in the Prometheus text format. */
export class Metrics {
  private readonly counters = new Map<string, number>()

  increment(name: string, labels: Record<string, string> = {}): void {
    const key = name + serializeLabels(labels)
    this.counters.set(key, (this.counters.get(key) ?? 0) + 1)
  }

  render(): string {
    const lines: string[] = []
    for (const [key, value] of [...this.counters.entries()].sort()) {
      lines.push(`${key} ${value}`)
    }
    return lines.join('\n') + '\n'
  }
}

function serializeLabels(labels: Record<string, string>): string {
  const entries = Object.entries(labels)
  if (entries.length === 0) return ''
  const body = entries
    .map(([key, value]) => `${key}="${value.replace(/["\\\n]/g, '_')}"`)
    .join(',')
  return `{${body}}`
}
