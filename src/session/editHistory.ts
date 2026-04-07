export type EditSnapshot = {
  relPath: string
  /** null 表示当时文件不存在，撤销时删除该路径 */
  previous: string | null
}

const DEFAULT_MAX = 30

export class EditHistory {
  private stack: EditSnapshot[] = []
  private readonly maxDepth: number

  constructor(maxDepth: number = DEFAULT_MAX) {
    this.maxDepth = maxDepth
  }

  push(snap: EditSnapshot): void {
    this.stack.push(snap)
    while (this.stack.length > this.maxDepth) {
      this.stack.shift()
    }
  }

  peek(): EditSnapshot | undefined {
    return this.stack[this.stack.length - 1]
  }

  pop(): EditSnapshot | undefined {
    return this.stack.pop()
  }

  get depth(): number {
    return this.stack.length
  }
}
