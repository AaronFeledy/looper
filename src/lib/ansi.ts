import { RGBA, StyledText, TextAttributes, type TextChunk } from "@opentui/core"

const ANSI_PATTERN = /(?:\u001B\[[0-?]*[ -/]*[@-~]|\u009B[0-?]*[ -/]*[@-~]|\u001B\][\s\S]*?(?:\u0007|\u001B\\|\u009C)|\u009D[\s\S]*?(?:\u0007|\u001B\\|\u009C)|\u001B[P^_X][\s\S]*?(?:\u001B\\|\u009C)|[\u0090\u0098\u009E\u009F][\s\S]*?(?:\u001B\\|\u009C)|\u001B[ -/][@-~]|\u001B[0-~]|[\u0080-\u009F])/g
const SGR_PATTERN = /(?:\u001B\[([0-9;]*)m|\u009B([0-9;]*)m)/g

const normalizeNewlines = (value: string): string => value.replace(/\r+\n/g, '\n')

const visibleCarriageReturnSegment = (value: string): string => {
  const carriageReturnIndex = value.lastIndexOf('\r')
  return carriageReturnIndex === -1 ? value : value.slice(carriageReturnIndex + 1)
}

export function stripAnsi(input: string): string {
  return input.replace(ANSI_PATTERN, '')
}

export function sanitizeTerminalText(input: string): string {
  return stripAnsi(input).replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '')
}

type AnsiStyle = {
  fg?: RGBA
  bg?: RGBA
  attributes: number
}

function styledChunk(text: string, style: AnsiStyle): TextChunk {
  const chunk: TextChunk = { __isChunk: true, text }
  if (style.fg) chunk.fg = style.fg
  if (style.bg) chunk.bg = style.bg
  if (style.attributes !== TextAttributes.NONE) chunk.attributes = style.attributes
  return chunk
}

function applySgrCode(codes: number[], index: number, style: AnsiStyle): number {
  const code = codes[index] ?? 0
  if (code === 0) {
    style.fg = undefined
    style.bg = undefined
    style.attributes = TextAttributes.NONE
    return index
  }
  if (code === 1) style.attributes |= TextAttributes.BOLD
  else if (code === 2) style.attributes |= TextAttributes.DIM
  else if (code === 3) style.attributes |= TextAttributes.ITALIC
  else if (code === 4) style.attributes |= TextAttributes.UNDERLINE
  else if (code === 5) style.attributes |= TextAttributes.BLINK
  else if (code === 7) style.attributes |= TextAttributes.INVERSE
  else if (code === 9) style.attributes |= TextAttributes.STRIKETHROUGH
  else if (code === 22) style.attributes &= ~(TextAttributes.BOLD | TextAttributes.DIM)
  else if (code === 23) style.attributes &= ~TextAttributes.ITALIC
  else if (code === 24) style.attributes &= ~TextAttributes.UNDERLINE
  else if (code === 25) style.attributes &= ~TextAttributes.BLINK
  else if (code === 27) style.attributes &= ~TextAttributes.INVERSE
  else if (code === 29) style.attributes &= ~TextAttributes.STRIKETHROUGH
  else if (code === 39) style.fg = undefined
  else if (code === 49) style.bg = undefined
  else if (code >= 30 && code <= 37) style.fg = RGBA.fromIndex(code - 30)
  else if (code >= 40 && code <= 47) style.bg = RGBA.fromIndex(code - 40)
  else if (code >= 90 && code <= 97) style.fg = RGBA.fromIndex(code - 90 + 8)
  else if (code >= 100 && code <= 107) style.bg = RGBA.fromIndex(code - 100 + 8)
  else if ((code === 38 || code === 48) && codes[index + 1] === 5 && codes[index + 2] !== undefined) {
    const color = RGBA.fromIndex(codes[index + 2]!)
    if (code === 38) style.fg = color
    else style.bg = color
    return index + 2
  } else if (
    (code === 38 || code === 48) &&
    codes[index + 1] === 2 &&
    codes[index + 2] !== undefined &&
    codes[index + 3] !== undefined &&
    codes[index + 4] !== undefined
  ) {
    const color = RGBA.fromInts(codes[index + 2]!, codes[index + 3]!, codes[index + 4]!)
    if (code === 38) style.fg = color
    else style.bg = color
    return index + 4
  }
  return index
}

function applySgr(params: string, style: AnsiStyle): void {
  const codes = params === '' ? [0] : params.split(';').map((part) => Number.parseInt(part || '0', 10)).filter(Number.isFinite)
  for (let index = 0; index < codes.length; index += 1) {
    index = applySgrCode(codes, index, style)
  }
}

export function ansiToStyledText(input: string): StyledText {
  const chunks: TextChunk[] = []
  const style: AnsiStyle = { attributes: TextAttributes.NONE }
  let lastIndex = 0

  for (const match of input.matchAll(SGR_PATTERN)) {
    const index = match.index ?? 0
    const text = stripAnsi(input.slice(lastIndex, index))
    if (text.length > 0) chunks.push(styledChunk(text, style))
    applySgr(match[1] ?? match[2] ?? '', style)
    lastIndex = index + match[0].length
  }

  const tail = stripAnsi(input.slice(lastIndex))
  if (tail.length > 0) chunks.push(styledChunk(tail, style))
  return new StyledText(chunks.length > 0 ? chunks : [styledChunk('', style)])
}

type LineBatcherOptions = {
  intervalMs?: number
  preserveAnsi?: boolean
}

type LineBatcher = {
  write: (chunk: Buffer | string) => void
  flush: () => void
  stop: () => void
}

export function createLineBatcher(
  onLines: (lines: string[]) => void,
  opts: LineBatcherOptions = {},
): LineBatcher {
  const intervalMs = opts.intervalMs ?? 100
  const preserveAnsi = opts.preserveAnsi ?? false
  const maxBatchSize = 200
  let timer: ReturnType<typeof setInterval> | undefined
  let pending = ''
  let pendingLines: string[] = []
  let stopped = false

  const emit = (lines: string[]) => {
    if (lines.length > 0) {
      onLines(lines)
    }
  }

  const flushCompleteLines = (drainAll: boolean) => {
    if (pendingLines.length === 0) {
      return
    }

    const batch = drainAll ? pendingLines : pendingLines.splice(0, maxBatchSize)
    if (drainAll) {
      pendingLines = []
    }
    emit(batch)
  }

  const startTimer = () => {
    if (timer !== undefined) {
      return
    }

    timer = setInterval(() => {
      flushCompleteLines(false)
    }, intervalMs)
  }

  const flushFinal = () => {
    flushCompleteLines(true)

    if (pending.length === 0) {
      return
    }

    const finalLines = normalizeNewlines(pending)
      .split('\n')
      .map(visibleCarriageReturnSegment)
      .map((line) => preserveAnsi ? line : stripAnsi(line))
      .filter((line) => line.length > 0)
    pending = ''

    emit(finalLines)
  }

  return {
    write(chunk) {
      if (stopped) {
        return
      }

      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      pending += text
      pending = normalizeNewlines(pending)

      const segments = pending.split('\n')
      // Collapse CR overwrites in the retained tail so newline-less progress redraws can't grow `pending` unbounded.
      pending = visibleCarriageReturnSegment(segments.pop() ?? '')

      for (const segment of segments) {
        const trimmedLine = visibleCarriageReturnSegment(segment)
        const line = preserveAnsi ? trimmedLine : stripAnsi(trimmedLine)
        if (line.length > 0) {
          pendingLines.push(line)
        }
      }

      if (pendingLines.length > 0) {
        startTimer()
      }
    },
    flush() {
      if (stopped) {
        return
      }

      flushFinal()
    },
    stop() {
      if (stopped) {
        return
      }

      stopped = true

      if (timer !== undefined) {
        clearInterval(timer)
        timer = undefined
      }

      flushFinal()
    },
  }
}
