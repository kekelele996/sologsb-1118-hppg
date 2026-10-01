/** 触发浏览器下载文本文件 */
export function downloadText(filename: string, content: string, mime = 'text/plain;charset=utf-8'): void {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

/** 导出 JSON */
export function downloadJson(filename: string, data: unknown): void {
  downloadText(filename, JSON.stringify(data, null, 2), 'application/json;charset=utf-8')
}

/** 选择并读取本地文本文件（交接包 / 回执上传用） */
export function pickTextFile(accept = '.json,application/json'): Promise<string> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept
    input.onchange = () => {
      const file = input.files?.[0]
      if (!file) {
        reject(new Error('未选择文件'))
        return
      }
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result ?? ''))
      reader.onerror = () => reject(reader.error ?? new Error('文件读取失败'))
      reader.readAsText(file, 'utf-8')
    }
    input.click()
  })
}

/** 数组转 CSV */
export function toCsv<T extends Record<string, unknown>>(
  rows: T[],
  headers: { key: keyof T; label: string }[]
): string {
  const head = headers.map((item) => item.label).join(',')
  const body = rows
    .map((row) =>
      headers
        .map((item) => {
          const raw = row[item.key]
          const text = raw === null || raw === undefined ? '' : String(raw)
          return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
        })
        .join(',')
    )
    .join('\n')
  return `${head}\n${body}\n`
}

/** 导出 CSV */
export function downloadCsv<T extends Record<string, unknown>>(
  filename: string,
  rows: T[],
  headers: { key: keyof T; label: string }[]
): void {
  downloadText(filename, toCsv(rows, headers), 'text/csv;charset=utf-8')
}
