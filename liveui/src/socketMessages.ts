export type SocketLike = {
  readonly readyState: number
  send(data: string): void
}

export const SOCKET_OPEN = 1

export function isSocketOpen(socket: Pick<SocketLike, 'readyState'>): boolean {
  return socket.readyState === SOCKET_OPEN
}

export function sendSocketMessage(
  socket: SocketLike,
  type: string,
  data?: unknown,
): boolean {
  if (!isSocketOpen(socket)) return false
  socket.send(JSON.stringify(data === undefined ? { type } : { type, data }))
  return true
}
